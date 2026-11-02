import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { indexStatuses, type GitFileStatus } from "@/lib/git-status";
import type { rpcContract } from "../contract";
import type { GitStatusResult } from "../shared";

/**
 * An agent edits files while the user watches, so status is polled rather
 * than read once. Hidden windows do not poll; returning to one re-reads.
 */
const POLL_MS = 3000;

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

const EMPTY: GitStatusResult = { isRepository: false, entries: [], truncated: false };

interface Store {
  value: GitStatusResult;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  inFlight: boolean;
  rpc: Rpc;
}

/** One poll per root, shared by the tree and the Changes tab. */
const stores = new Map<string, Store>();

function sameEntries(left: GitStatusResult["entries"], right: GitStatusResult["entries"]): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index]!;
    return entry.path === other.path && entry.status === other.status
      && entry.staged === other.staged && entry.unstaged === other.unstaged;
  });
}

function sameResult(left: GitStatusResult, right: GitStatusResult): boolean {
  if (left.isRepository !== right.isRepository || left.truncated !== right.truncated) return false;
  if (!sameEntries(left.entries, right.entries)) return false;
  const a = left.branch ?? null;
  const b = right.branch ?? null;
  if (a === null || b === null) return a === b;
  return a.base === b.base && a.commits === b.commits && sameEntries(a.entries, b.entries);
}

async function refresh(rootId: string): Promise<void> {
  const store = stores.get(rootId);
  if (store === undefined || store.inFlight || document.visibilityState === "hidden") return;
  store.inFlight = true;
  try {
    const next = await store.rpc.call("gitStatus", { rootId });
    if (sameResult(store.value, next)) return;
    store.value = next;
    for (const listener of store.listeners) listener();
  } catch {
    // An expired root or a disconnected host keeps the last answer on screen.
  } finally {
    store.inFlight = false;
  }
}

function subscribe(rootId: string, rpc: Rpc, listener: () => void): () => void {
  let store = stores.get(rootId);
  if (store === undefined) {
    store = { value: EMPTY, listeners: new Set(), timer: null, inFlight: false, rpc };
    stores.set(rootId, store);
  }
  store.rpc = rpc;
  store.listeners.add(listener);
  if (store.timer === null) {
    store.timer = setInterval(() => void refresh(rootId), POLL_MS);
    void refresh(rootId);
  }
  return () => {
    const current = stores.get(rootId);
    if (current === undefined) return;
    current.listeners.delete(listener);
    if (current.listeners.size > 0) return;
    // The last answer stays, so switching tabs or folders back shows it at
    // once; only the polling stops.
    if (current.timer !== null) clearInterval(current.timer);
    current.timer = null;
  };
}

/** Re-read now, after the plugin itself changed files. */
export function refreshGitStatus(rootId: string): void {
  void refresh(rootId);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    for (const [rootId, store] of stores) if (store.timer !== null) void refresh(rootId);
  });
}

export interface GitStatusModel {
  result: GitStatusResult;
  /** Every changed file and every folder above one. */
  byPath: ReadonlyMap<string, GitFileStatus>;
}

export function useGitStatus(rootId: string | null): GitStatusModel {
  const rpc = useRpc<typeof rpcContract>();
  const subscribeToRoot = useCallback(
    (listener: () => void) => (rootId === null ? () => undefined : subscribe(rootId, rpc, listener)),
    [rootId, rpc],
  );
  const result = useSyncExternalStore(
    subscribeToRoot,
    () => (rootId === null ? EMPTY : stores.get(rootId)?.value ?? EMPTY),
  );
  useEffect(() => {
    if (rootId !== null) refreshGitStatus(rootId);
  }, [rootId]);
  const byPath = useMemo(() => indexStatuses(result.entries), [result]);
  return { result, byPath };
}
