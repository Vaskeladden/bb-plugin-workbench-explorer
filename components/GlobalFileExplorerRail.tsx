import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useBbContext, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { FileExplorerPanel } from "@/components/FileExplorerPanel";
import { FileContentSearchPanel } from "@/components/FileContentSearchPanel";
import { ChangesPanel } from "@/components/ChangesPanel";
import { ConfirmHost } from "@/components/ConfirmHost";
import { QuickOpen } from "@/components/QuickOpen";
import { publishedLines, type PublishedCategoryLines } from "@/lib/change-category";
import { subscribeTextSearch } from "@/lib/text-search-bus";
import { useGitStatus } from "@/hooks/useGitStatus";
import { RailResizeHandle } from "@/components/RailResizeHandle";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { cn } from "@/lib/utils";
import { acquireRailInset, syncRailInset } from "@/lib/rail-inset";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { RAIL_EVENT, initializeRailOpen, writeStoredOpen } from "@/lib/rail-state";
import { getFindInFolder, subscribeFindInFolder } from "@/lib/find-in-folder";
import { useRailWidthPx } from "@/lib/rail-width";
import { useWindowFrame } from "@/lib/window-frame";
import { TitleBarFileExplorerToggle } from "@/components/TitleBarFileExplorerToggle";
import type { RootChoice } from "../shared";
import type { rpcContract } from "../contract";

/**
 * Window event other plugins dispatch to toggle the rail's Changes tab: open
 * the rail on it, or close the rail when it already shows Changes.
 */
const TOGGLE_CHANGES_EVENT = "bb-plugin-workbench-explorer:toggle-changes";
/** Window event (and global with the latest value) carrying the Changes tab's counts. */
const CHANGES_SUMMARY_EVENT = "bb-plugin-workbench-explorer:changes-summary";
const CHANGES_SUMMARY_GLOBAL = "__bbWorkbenchExplorerChanges";

/**
 * Published on `window[CHANGES_SUMMARY_GLOBAL]` and as the detail of
 * `CHANGES_SUMMARY_EVENT` for other plugins. `lines` holds added and deleted
 * lines per kind of file ("code" | "conf" | "test" | "docs", from
 * `changeCategory`) for each list on its own: `uncommitted` against HEAD,
 * `branch` the branch's commits since its merge base. A list is null when it
 * has a text file without line counts, and `branch` is null without a branch
 * comparison. Binary files count in `files` with no lines.
 */
interface ExplorerChangesSummary {
  threadId: string | null;
  uncommitted: number;
  branch: number;
  /** Distinct files across both lists. */
  total: number;
  base: string | null;
  pullRequest: number | null;
  /** The rail is open on the Changes tab. */
  showing: boolean;
  lines: {
    uncommitted: PublishedCategoryLines | null;
    branch: PublishedCategoryLines | null;
  };
}

const ROOT_STORAGE_KEY = "bb-plugin-workbench-explorer:pinned-root";

/** The views the rail carries: names, the text inside them, and what changed. */
type ExplorerTab = "files" | "search" | "changes";
const TAB_STORAGE_KEY = "bb-plugin-workbench-explorer:tab";

function readStoredTab(): ExplorerTab {
  try {
    const stored = localStorage.getItem(TAB_STORAGE_KEY);
    return stored === "search" || stored === "changes" ? stored : "files";
  } catch {
    return "files";
  }
}

function writeStoredTab(tab: ExplorerTab): void {
  try {
    localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    // The choice still lasts for this window when storage is unavailable.
  }
}

function readPinnedRoot(): string | null {
  try {
    const value = localStorage.getItem(ROOT_STORAGE_KEY);
    return value !== null && /^(?:thread|source|personal):[\w-]{1,128}$/u.test(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function writePinnedRoot(id: string): void {
  try {
    localStorage.setItem(ROOT_STORAGE_KEY, id);
  } catch {
    // The choice still lasts for this window when storage is unavailable.
  }
}

/** Mounted once per BB window. Navigation never owns or unmounts the tree. */
export function GlobalFileExplorerRail() {
  const rpc = useRpc<typeof rpcContract>();
  const { threadId, projectId } = useBbContext();
  const { values, isLoading: settingsLoading } = useSettings();
  const compact = useIsCompactViewport();
  const railWidthPx = useRailWidthPx();
  const frame = useWindowFrame();
  const portalScopeProps = usePortalScopeProps();
  const insetHolderId = useRef(`file-explorer:window:${Math.random().toString(36).slice(2)}`).current;
  const initialized = useRef(false);
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(readPinnedRoot);
  const [choices, setChoices] = useState<RootChoice[]>([]);
  const [loadingRoots, setLoadingRoots] = useState(true);
  const [rootError, setRootError] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const [tab, setTab] = useState<ExplorerTab>(readStoredTab);

  // A right-clicked "Find in Folder" opens the tab that answers it. The panel
  // reads the same request and scopes its query to that folder.
  const findInFolder = useSyncExternalStore(subscribeFindInFolder, getFindInFolder);
  // Another plugin (conductor-actions' header "Changes" button) toggles the
  // Changes tab: a second click closes the rail again.
  const showingChanges = useRef(false);
  useEffect(() => {
    const toggleChanges = () => {
      if (showingChanges.current) {
        writeStoredOpen(false);
        return;
      }
      writeStoredOpen(true);
      setTab("changes");
      writeStoredTab("changes");
    };
    window.addEventListener(TOGGLE_CHANGES_EVENT, toggleChanges);
    return () => window.removeEventListener(TOGGLE_CHANGES_EVENT, toggleChanges);
  }, []);
  useEffect(() => subscribeTextSearch(() => {
    writeStoredOpen(true);
    setTab("search");
    writeStoredTab("search");
  }), []);
  useEffect(() => {
    if (findInFolder === null) return;
    setTab("search");
    writeStoredTab("search");
  }, [findInFolder]);

  useEffect(() => {
    if (settingsLoading || initialized.current) return;
    initialized.current = true;
    if (compact) writeStoredOpen(false);
    setOpen(compact ? false : initializeRailOpen(values?.openByDefault !== false));
    setReady(true);
  }, [compact, settingsLoading, values?.openByDefault]);

  useEffect(() => {
    const onRailEvent = (event: Event) => {
      const next = (event as CustomEvent<boolean>).detail;
      if (typeof next === "boolean") setOpen(next);
    };
    window.addEventListener(RAIL_EVENT, onRailEvent);
    return () => window.removeEventListener(RAIL_EVENT, onRailEvent);
  }, []);

  const pinnedThreadId = selectedId?.startsWith("thread:") ? selectedId.slice(7) : null;
  /** The thread the selector last followed, so a manual choice survives re-renders. */
  const lastFollowedThread = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setLoadingRoots(true);
    void rpc.call("listRootChoices", { currentThreadId: threadId, pinnedThreadId })
      .then(({ choices: next }) => {
        if (cancelled) return;
        setChoices(next);
        // Opening a thread shows that thread's own checkout: its worktree
        // when it has one, else its project's source. The selector follows
        // the route. The pinned choice is what New Thread keeps — there is no
        // thread there to follow.
        if (threadId !== null && lastFollowedThread.current !== threadId) {
          lastFollowedThread.current = threadId;
          const follow = next.find((choice) => choice.id === `thread:${threadId}`)
            ?? next.find((choice) => choice.id.startsWith("source:") && choice.projectId === projectId)
            ?? next.find((choice) => choice.id === `personal:${projectId}`)
            ?? next.find((choice) => choice.projectId !== null && choice.projectId === projectId);
          if (follow !== undefined) {
            if (follow.id !== selectedId) {
              setSelectedId(follow.id);
              writePinnedRoot(follow.id);
            }
            return;
          }
        }
        if (selectedId === null) {
          const preferred = next.find((choice) => choice.id === `thread:${threadId}`)
            ?? next.find((choice) => choice.id === `personal:${projectId}`)
            ?? next.find((choice) => choice.projectId !== null && choice.projectId === projectId)
            ?? next[0];
          if (preferred !== undefined) {
            setSelectedId(preferred.id);
            writePinnedRoot(preferred.id);
          }
        }
      })
      .catch((cause) => {
        if (!cancelled) setRootError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoadingRoots(false);
      });
    return () => { cancelled = true; };
  }, [rpc, threadId, projectId, pinnedThreadId, selectedId, refreshCount, values?.treeRoot]);

  const chosen = choices.find((choice) => choice.id === selectedId);
  const gitStatus = useGitStatus(chosen?.workspace.rootId ?? null).result;
  const changeCount = gitStatus.entries.length;
  // Tell other plugins what the Changes tab holds for the open thread, so a
  // header button can show the count without polling git a second time.
  useEffect(() => {
    const branchPaths = gitStatus.branch?.entries.map((entry) => entry.path) ?? [];
    const detail: ExplorerChangesSummary = {
      threadId,
      uncommitted: gitStatus.entries.length,
      branch: branchPaths.length,
      total: new Set([...gitStatus.entries.map((entry) => entry.path), ...branchPaths]).size,
      base: gitStatus.branch?.base ?? null,
      pullRequest: gitStatus.branch?.pullRequest ?? null,
      showing: ready && open && tab === "changes",
      lines: {
        uncommitted: publishedLines(gitStatus.entries),
        branch: gitStatus.branch ? publishedLines(gitStatus.branch.entries) : null,
      },
    };
    showingChanges.current = detail.showing;
    (window as unknown as Record<string, unknown>)[CHANGES_SUMMARY_GLOBAL] = detail;
    window.dispatchEvent(new CustomEvent(CHANGES_SUMMARY_EVENT, { detail }));
  }, [gitStatus, threadId, ready, open, tab]);
  const railOpen = ready && open;
  useLayoutEffect(() => {
    if (!railOpen || compact) {
      syncRailInset();
      return;
    }
    return acquireRailInset(insetHolderId);
  }, [compact, insetHolderId, railOpen]);

  if (!ready) return null;
  // BB's desktop window is framed: a full-width title bar (z-index 44) sits
  // over the top of the window. The rail starts below it as a card of its own,
  // and its toggle joins BB's title-bar buttons, so nothing the user can click
  // is left underneath the title bar.
  const framed = frame !== null && !compact;
  return <>
    {framed ? <TitleBarFileExplorerToggle open={railOpen} /> : null}
    <ConfirmHost />
    <QuickOpen root={chosen?.workspace ?? null} />
    {createPortal(
    <aside
      {...portalScopeProps}
      className="fixed bottom-0 right-0 top-0 z-40 flex-col text-sidebar-foreground"
      style={{
        display: railOpen ? "flex" : "none",
        width: compact ? "100vw" : framed ? `calc(${railWidthPx}px + ${frame.lip})` : `${railWidthPx}px`,
        ...(framed
          ? {
            paddingTop: frame.top,
            paddingRight: frame.lip,
            paddingBottom: frame.lip,
            backgroundColor: "var(--sidebar)",
            backgroundImage: "linear-gradient(var(--surface-recessed), var(--surface-recessed))",
          }
          : {}),
      }}
      aria-label="File Explorer"
    >
      {compact ? null : <RailResizeHandle />}
      <div
        className={cn(
          "relative flex min-h-0 flex-1 flex-col bg-sidebar",
          framed ? "overflow-clip rounded-xl border" : "border-l border-sidebar-border",
        )}
        style={framed ? { borderColor: "var(--border-seam)" } : undefined}
      >
      <div className="flex h-[48px] shrink-0 items-center justify-between border-b border-sidebar-border pl-3 pr-1">
        <span className="truncate text-sm font-medium text-muted-foreground">Explorer</span>
        <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 p-0"
          aria-label="Hide file explorer (⌘B)"
          onClick={() => writeStoredOpen(false)}>
          <Icon name="X" className="size-4" />
        </Button>
      </div>
      <div className="flex shrink-0 items-center gap-1 border-b border-sidebar-border px-1.5 py-1">
        <SearchableSelect
          ariaLabel="File Explorer folder"
          triggerTitle="Pinned folder — switching threads does not change this tree"
          value={selectedId}
          onValueChange={(id) => {
            setSelectedId(id);
            writePinnedRoot(id);
          }}
          placeholder="Choose a folder"
          searchPlaceholder="Search projects…"
          options={choices.map((choice) => ({
            value: choice.id,
            label: choice.label,
          }))}
          triggerClassName="bg-sidebar"
        />
        <button type="button" aria-label="Refresh folder list" title="Refresh folder list"
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-state-hover"
          onClick={() => setRefreshCount((count) => count + 1)}>
          <Icon name="RotateCcw" className="size-3" />
        </button>
      </div>
      <div
        role="tablist"
        aria-label="File explorer view"
        className="flex shrink-0 items-center gap-0.5 border-b border-sidebar-border px-1.5 py-1"
      >
        {(
          [
            { id: "files", icon: "FileText", label: "Files" },
            { id: "search", icon: "Search", label: "Search" },
            { id: "changes", icon: "GitBranch", label: "Changes" },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            title={item.label}
            onClick={() => {
              setTab(item.id);
              writeStoredTab(item.id);
            }}
            className={cn(
              "flex h-6 min-w-0 flex-1 items-center justify-center gap-1 rounded-[4px] text-[11px] leading-4",
              "hover:bg-state-hover",
              tab === item.id && "bg-state-active font-medium text-foreground hover:bg-state-active",
            )}
          >
            <Icon name={item.icon} className="size-3.5 shrink-0" />
            {/* Three labels do not fit a narrow rail; the icons and tooltips still do. */}
            {railWidthPx < 260 ? null : <span className="truncate">{item.label}</span>}
            {item.id === "changes" && changeCount > 0 ? (
              <span className="shrink-0 rounded-full bg-state-active px-1 font-mono text-[9px] leading-3.5">{changeCount}</span>
            ) : null}
          </button>
        ))}
      </div>
      {rootError !== null ? <p className="px-2 py-2 text-[11px] text-destructive">{rootError}</p> : null}
      {loadingRoots && choices.length === 0 ? <p className="px-2 py-2 text-[11px] text-muted-foreground">Loading folders…</p> : null}
      {tab === "files" ? (
        <FileExplorerPanel root={chosen?.workspace ?? null} />
      ) : tab === "changes" ? (
        <ChangesPanel root={chosen?.workspace ?? null} />
      ) : (
        <FileContentSearchPanel root={chosen?.workspace ?? null} />
      )}
      </div>
    </aside>,
    document.body,
    )}
  </>;
}
