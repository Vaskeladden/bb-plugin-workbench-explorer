import { useEffect, useState } from "react";
import { experimental_Diff as Diff, useRpc, type JsonValue } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../contract";

export const FILE_DIFF_ACTION_ID = "file-diff";

/** An agent may still be editing the file, so the diff follows it. */
const POLL_MS = 3000;

export interface FileDiffParams {
  rootId: string;
  relativePath: string;
  /**
   * Root ids live in the server's memory, so a tab restored after a restart
   * finds its root again by these. Optional: tabs opened before they existed
   * still parse.
   */
  hostId?: string;
  rootPath?: string;
  /** "base": what the branch's commits changed since the default branch. */
  against?: "base";
  /** The pull request whose head the base diff reads, when the checkout is on the default branch. */
  pullRequest?: number;
}

/** Tab params round-trip through persistence, so they are checked, not trusted. */
export function parseFileDiffParams(params: JsonValue | null): FileDiffParams | null {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return null;
  const { rootId, relativePath, hostId, rootPath, against, pullRequest } = params as Record<string, JsonValue>;
  if (typeof rootId !== "string" || rootId === "") return null;
  if (typeof relativePath !== "string" || relativePath === "") return null;
  return {
    rootId,
    relativePath,
    ...(typeof hostId === "string" && typeof rootPath === "string" ? { hostId, rootPath } : {}),
    ...(against === "base" ? { against: "base" as const } : {}),
    ...(typeof pullRequest === "number" && Number.isInteger(pullRequest) && pullRequest > 0 ? { pullRequest } : {}),
  };
}

type DiffState =
  | { kind: "loading" }
  | { kind: "ready"; patch: string | null }
  | { kind: "error"; message: string };

export function FileDiffPanel({ threadId, params }: { threadId: string; params: JsonValue | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const target = parseFileDiffParams(params);
  const [state, setState] = useState<DiffState>({ kind: "loading" });
  const [view, setView] = useState<"unified" | "split">("unified");

  const relativePath = target?.relativePath ?? null;
  const hostId = target?.hostId ?? null;
  const rootPath = target?.rootPath ?? null;
  const against = target?.against ?? null;
  const pullRequest = target?.pullRequest ?? null;
  const [rootId, setRootId] = useState<string | null>(target?.rootId ?? null);
  useEffect(() => setRootId(target?.rootId ?? null), [target?.rootId]);

  useEffect(() => {
    if (rootId === null || relativePath === null) return;
    let cancelled = false;
    let reresolved = false;
    // The server forgot the root (a restart, a plugin reload): look it up
    // again among the roots the server offers, by the path it had.
    const reresolve = async (): Promise<boolean> => {
      if (reresolved || hostId === null || rootPath === null) return false;
      reresolved = true;
      const { choices } = await rpc.call("listRootChoices", { currentThreadId: threadId, pinnedThreadId: null });
      const match = choices.find((choice) =>
        choice.workspace.hostId === hostId && choice.workspace.rootPath === rootPath);
      if (match === undefined || cancelled) return false;
      setRootId(match.workspace.rootId);
      return true;
    };
    const load = () => {
      if (document.visibilityState === "hidden") return;
      rpc.call("gitDiff", { rootId, relativePath, ...(against === null ? {} : { against }), ...(pullRequest === null ? {} : { pullRequest }) })
        .then(async (result) => {
          if (!result.ok && await reresolve()) return;
          if (cancelled) return;
          setState((current) => {
            const next: DiffState = result.ok
              ? { kind: "ready", patch: result.patch }
              : { kind: "error", message: result.message };
            // Polling must not re-render the diff when nothing changed.
            if (current.kind === "ready" && next.kind === "ready" && current.patch === next.patch) return current;
            return next;
          });
        })
        .catch((cause: unknown) => {
          if (!cancelled) setState({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
        });
    };
    setState({ kind: "loading" });
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [rpc, rootId, relativePath, hostId, rootPath, threadId, against, pullRequest]);

  if (target === null) {
    return <p className="p-4 text-sm text-muted-foreground">Open a file from the File Explorer's Changes tab to see its diff.</p>;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={target.relativePath}>
          {target.relativePath}
        </span>
        <div className="flex shrink-0 rounded-md border border-border p-0.5">
          {(["unified", "split"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={view === mode}
              onClick={() => setView(mode)}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-state-hover",
                view === mode && "bg-state-active text-foreground",
              )}
            >
              {mode === "unified" ? "Inline" : "Side by side"}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {state.kind === "loading" ? (
          <p className="p-4 text-sm text-muted-foreground">Loading diff…</p>
        ) : state.kind === "error" ? (
          <p className="p-4 text-sm text-destructive">{state.message}</p>
        ) : state.patch === null ? (
          <p className="p-4 text-sm text-muted-foreground">
            {against === "base" ? "The branch's commits do not change this file." : "No uncommitted changes in this file."}
          </p>
        ) : (
          <Diff patch={state.patch} path={target.relativePath} view={view} />
        )}
      </div>
    </div>
  );
}
