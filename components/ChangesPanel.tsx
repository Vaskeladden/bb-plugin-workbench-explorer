import { useMemo, useState, type ReactNode } from "react";
import { useBbContext, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { FILE_DIFF_ACTION_ID } from "@/components/FileDiffPanel";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { refreshGitStatus, useGitStatus } from "@/hooks/useGitStatus";
import { requestConfirm } from "@/lib/confirm-bus";
import { STATUS_BADGE, STATUS_LABEL, STATUS_TEXT, type GitStatusEntry } from "@/lib/git-status";
import { openWorkspaceFile } from "@/lib/open-preview";
import { surfaceNavigation } from "@/lib/surface-navigation";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../contract";
import type { Workspace } from "../shared";

type GitAction = "stage" | "unstage" | "discard";
type GroupId = "staged" | "changes" | "branch";

const COLLAPSED_KEY = "bb-plugin-workbench-explorer:changes-collapsed";

function splitPath(path: string): { name: string; folder: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? { name: path, folder: "" } : { name: path.slice(slash + 1), folder: path.slice(0, slash) };
}

function byPath(entries: readonly GitStatusEntry[]): GitStatusEntry[] {
  return [...entries].sort((left, right) => left.path.localeCompare(right.path));
}

function readCollapsed(): Set<GroupId> {
  try {
    const stored = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(stored) ? (stored.filter((id) => typeof id === "string") as GroupId[]) : []);
  } catch {
    return new Set();
  }
}

/**
 * VS Code's Source Control list, inside the explorer so it stays beside the
 * file or diff it opens: staged files, unstaged files, and what the branch's
 * commits changed compared with the default branch, as the pull request shows.
 */
export function ChangesPanel({ root }: { root: Workspace | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const { threadId } = useBbContext();
  const { result } = useGitStatus(root?.rootId ?? null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [busy, setBusy] = useState(false);
  const staged = useMemo(() => byPath(result.entries.filter((entry) => entry.staged)), [result.entries]);
  // Entries from an older host without the flags count as unstaged.
  const unstaged = useMemo(
    () => byPath(result.entries.filter((entry) => entry.unstaged !== false || entry.staged === undefined)),
    [result.entries],
  );
  const branch = result.branch ?? null;
  const branchEntries = useMemo(() => byPath(branch?.entries ?? []), [branch]);

  if (root === null) {
    return <p className="px-2 py-3 text-[11px] text-muted-foreground">Choose a folder above.</p>;
  }
  if (!result.isRepository) {
    return <p className="px-2 py-3 text-[11px] text-muted-foreground">This folder is not in a git repository.</p>;
  }

  const report = (message: string) => {
    void rpc.call("clientLog", { message }).catch(() => undefined);
  };

  const toggle = (id: GroupId) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const openDiff = (relativePath: string, against: "head" | "base") => {
    const navigation = surfaceNavigation(threadId);
    const { name } = splitPath(relativePath);
    const opened = navigation?.openThreadPanel({
      actionId: FILE_DIFF_ACTION_ID,
      title: against === "base" ? `${name} · vs ${branch?.base ?? "main"}` : `Diff · ${name}`,
      params: {
        rootId: root.rootId,
        relativePath,
        hostId: root.hostId,
        rootPath: root.rootPath,
        ...(against === "base" ? { against: "base" } : {}),
        ...(against === "base" && branch?.pullRequest ? { pullRequest: branch.pullRequest } : {}),
      },
    }) ?? false;
    if (!opened) toast.error("Open a thread to see diffs.");
  };

  const openFile = (relativePath: string) => {
    const navigation = surfaceNavigation(threadId);
    if (!openWorkspaceFile(navigation, root, relativePath, report)) {
      toast.error(navigation === null ? "Open a thread or New Thread page to preview files." : "Could not open the file preview.");
    }
  };

  const act = async (action: GitAction, paths: string[]) => {
    if (paths.length === 0 || busy) return;
    if (action === "discard") {
      const one = paths.length === 1 ? splitPath(paths[0]!).name : `${paths.length} files`;
      const confirmed = await requestConfirm({
        title: `Discard changes in ${one}?`,
        description: "The files go back to how HEAD has them. New files are deleted. This cannot be undone.",
        confirmLabel: "Discard",
      });
      if (!confirmed) return;
    }
    setBusy(true);
    try {
      const outcome = await rpc.call("gitAction", { rootId: root.rootId, action, relativePaths: paths });
      if (outcome.ok) toast.success(outcome.message);
      else toast.error(outcome.message);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      refreshGitStatus(root.rootId);
    }
  };

  const nothing = staged.length === 0 && unstaged.length === 0 && (branch === null || branchEntries.length === 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {nothing ? (
          <p className="px-1.5 py-3 text-[11px] text-muted-foreground">
            {branch === null ? "No uncommitted changes." : `No uncommitted changes, and no commits ahead of ${branch.base}.`}
          </p>
        ) : null}
        {staged.length > 0 ? (
          <Group
            id="staged"
            title="Staged"
            count={staged.length}
            collapsed={collapsed.has("staged")}
            onToggle={toggle}
            actions={<HeaderButton title="Unstage all" onClick={() => void act("unstage", staged.map((e) => e.path))}>−</HeaderButton>}
          >
            {staged.map((entry) => (
              <Row
                key={`s:${entry.path}`}
                entry={entry}
                onClick={() => openDiff(entry.path, "head")}
                onOpen={() => openFile(entry.path)}
                menu={[
                  { label: "Open diff", run: () => openDiff(entry.path, "head") },
                  { label: "Open file", run: () => openFile(entry.path), hidden: entry.status === "deleted" },
                  { label: "Unstage", run: () => void act("unstage", [entry.path]) },
                  { separator: true },
                  { label: "Discard changes", run: () => void act("discard", [entry.path]), danger: true },
                ]}
                buttons={<RowButton title="Unstage" onClick={() => void act("unstage", [entry.path])}>−</RowButton>}
              />
            ))}
          </Group>
        ) : null}
        {unstaged.length > 0 ? (
          <Group
            id="changes"
            title="Changes"
            count={unstaged.length}
            collapsed={collapsed.has("changes")}
            onToggle={toggle}
            actions={(
              <>
                <HeaderButton title="Discard all changes" onClick={() => void act("discard", unstaged.map((e) => e.path))}>↶</HeaderButton>
                <HeaderButton title="Stage all" onClick={() => void act("stage", unstaged.map((e) => e.path))}>+</HeaderButton>
              </>
            )}
          >
            {unstaged.map((entry) => (
              <Row
                key={`u:${entry.path}`}
                entry={entry}
                onClick={() => openDiff(entry.path, "head")}
                onOpen={() => openFile(entry.path)}
                menu={[
                  { label: "Open diff", run: () => openDiff(entry.path, "head") },
                  { label: "Open file", run: () => openFile(entry.path), hidden: entry.status === "deleted" },
                  { label: "Stage", run: () => void act("stage", [entry.path]) },
                  { separator: true },
                  { label: "Discard changes", run: () => void act("discard", [entry.path]), danger: true },
                ]}
                buttons={(
                  <>
                    <RowButton title="Discard changes" onClick={() => void act("discard", [entry.path])}>↶</RowButton>
                    <RowButton title="Stage" onClick={() => void act("stage", [entry.path])}>+</RowButton>
                  </>
                )}
              />
            ))}
          </Group>
        ) : null}
        {branch !== null && branchEntries.length > 0 ? (
          <Group
            id="branch"
            title={branch.pullRequest ? `#${branch.pullRequest} vs ${branch.base}` : `vs ${branch.base}`}
            subtitle={`${branch.commits} commit${branch.commits === 1 ? "" : "s"}`}
            count={branchEntries.length}
            collapsed={collapsed.has("branch")}
            onToggle={toggle}
          >
            {branchEntries.map((entry) => (
              <Row
                key={`b:${entry.path}`}
                entry={entry}
                onClick={() => openDiff(entry.path, "base")}
                onOpen={() => openFile(entry.path)}
                menu={[
                  { label: `Open diff vs ${branch.base}`, run: () => openDiff(entry.path, "base") },
                  { label: "Open file", run: () => openFile(entry.path), hidden: entry.status === "deleted" },
                ]}
              />
            ))}
          </Group>
        ) : null}
        {result.truncated ? (
          <p className="px-1.5 py-1 text-[10px] text-muted-foreground">Showing the first {result.entries.length} changes.</p>
        ) : null}
      </div>
    </div>
  );
}

function Group({ id, title, subtitle, count, collapsed, onToggle, actions, children }: {
  id: GroupId;
  title: string;
  subtitle?: string;
  count: number;
  collapsed: boolean;
  onToggle: (id: GroupId) => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="pt-1">
      <div className="group/header flex items-center rounded-[3px] pr-1 hover:bg-state-hover">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => onToggle(id)}
          className="flex min-w-0 flex-1 items-center gap-1 py-0.5 pl-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          <span className={cn("inline-block w-3 text-center transition-transform", collapsed ? "" : "rotate-90")}>›</span>
          <span className="truncate">{title}</span>
          {subtitle === undefined ? null : <span className="truncate font-normal normal-case text-muted-foreground/70">{subtitle}</span>}
        </button>
        <span className="hidden items-center group-hover/header:flex">{actions}</span>
        <span className="ml-1 rounded-full bg-state-active px-1.5 font-mono text-[10px] text-muted-foreground">{count}</span>
      </div>
      {collapsed ? null : <div>{children}</div>}
    </section>
  );
}

type MenuItem = { label: string; run: () => void; hidden?: boolean; danger?: boolean } | { separator: true };

function Row({ entry, onClick, onOpen, menu, buttons }: {
  entry: GitStatusEntry;
  onClick: () => void;
  onOpen: () => void;
  menu: MenuItem[];
  buttons?: ReactNode;
}) {
  const { name, folder } = splitPath(entry.path);
  const isDeleted = entry.status === "deleted";
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="group flex items-center rounded-[3px] hover:bg-state-hover">
          <button
            type="button"
            onClick={onClick}
            title={`${entry.path} · ${STATUS_LABEL[entry.status]} — click for the diff`}
            className="flex min-w-0 flex-1 items-center gap-1 py-px pl-4 pr-1 text-left text-[11px] leading-5"
          >
            <FileTypeIcon name={name} className="size-4" />
            <span className={cn("min-w-0 shrink truncate", STATUS_TEXT[entry.status], isDeleted && "line-through")}>{name}</span>
            {folder === "" ? null : <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/70">{folder}</span>}
          </button>
          <span className="hidden shrink-0 items-center group-hover:flex">
            {isDeleted ? null : <RowButton title="Open file" onClick={onOpen}>⧉</RowButton>}
            {buttons}
          </span>
          <span
            aria-label={STATUS_LABEL[entry.status]}
            className={cn("w-4 shrink-0 text-center font-mono text-[10px] leading-5", STATUS_TEXT[entry.status])}
          >
            {STATUS_BADGE[entry.status]}
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {menu.map((item, index) =>
          "separator" in item ? (
            <ContextMenuSeparator key={`sep-${index}`} />
          ) : item.hidden ? null : (
            <ContextMenuItem
              key={item.label}
              onSelect={item.run}
              className={cn(item.danger && "text-destructive focus:text-destructive")}
            >
              {item.label}
            </ContextMenuItem>
          ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function RowButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="flex size-5 items-center justify-center rounded text-[12px] leading-none text-muted-foreground hover:bg-state-active hover:text-foreground"
    >
      {children}
    </button>
  );
}

const HeaderButton = RowButton;
