/**
 * The rail's open/closed flag is shared by controls mounted in different BB
 * surfaces. It belongs to the thread on screen: every thread remembers whether
 * its rail was left open, and a thread it was never opened in starts closed,
 * so opening the rail for one thread does not open it for all the others.
 */
export const RAIL_STORAGE_KEY = "bb-plugin-workbench-explorer:rail-open";
export const RAIL_EVENT = "bb-plugin-workbench-explorer:rail-open";
/** Storage key and event name for the git plugin's rail. When this rail opens,
 *  the sibling rail is closed so the two right-side panels never overlap —
 *  both sit at `fixed right-0 z-40` in the host window. */
const SIBLING_RAIL_STORAGE_KEY = "bb-plugin-git:rail-open";
const SIBLING_RAIL_EVENT = "bb-plugin-git:rail-open";
/** The threads whose rail was left open, oldest first. A thread not listed is closed. */
const OPEN_THREADS_STORAGE_KEY = "bb-plugin-workbench-explorer:rail-open-threads";
const OPEN_THREADS_MAX = 300;
let currentOpen: boolean | null = null;
/** The thread on screen; null on a page without one, where the rail's state is not remembered. */
let shownThreadId: string | null = null;

function readOpenThreads(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(OPEN_THREADS_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function rememberThread(threadId: string, open: boolean): void {
  const others = readOpenThreads().filter((id) => id !== threadId);
  try {
    localStorage.setItem(OPEN_THREADS_STORAGE_KEY, JSON.stringify((open ? [...others, threadId] : others).slice(-OPEN_THREADS_MAX)));
  } catch {
    /* private mode */
  }
}

/** Close the sibling git rail by writing its storage key and dispatching its
 *  event so its mounted components observe the change. */
function closeSiblingRail(): void {
  try {
    localStorage.setItem(SIBLING_RAIL_STORAGE_KEY, "0");
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new CustomEvent(SIBLING_RAIL_EVENT, { detail: false }));
}

export function readStoredOpen(fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(RAIL_STORAGE_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    /* private mode */
  }
  return fallback;
}

/** Open or close the rail, and remember it for the thread on screen. */
export function writeStoredOpen(open: boolean): void {
  if (shownThreadId !== null) rememberThread(shownThreadId, open);
  applyOpen(open);
}

function applyOpen(open: boolean): void {
  currentOpen = open;
  try {
    localStorage.setItem(RAIL_STORAGE_KEY, open ? "1" : "0");
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new CustomEvent(RAIL_EVENT, { detail: open }));
  // Opening this rail must close the sibling so the two panels don't overlap.
  if (open) closeSiblingRail();
}

/**
 * Follow the thread on screen: the rail takes the state that thread was left
 * in, closed when it was never opened there. A page without a thread (null)
 * shows the rail closed and remembers nothing.
 */
export function showThread(threadId: string | null): boolean {
  shownThreadId = threadId;
  const open = threadId !== null && readOpenThreads().includes(threadId);
  applyOpen(open);
  return open;
}

/**
 * The rail was opened or closed by something other than this module (the
 * sibling rail closes this one when it opens): the thread on screen remembers
 * that too.
 */
export function noteRailOpen(open: boolean): void {
  if (shownThreadId !== null) rememberThread(shownThreadId, open);
}

export function toggleRailOpen(): void {
  // A click before the rail has mounted still means "show the panel".
  if (currentOpen === null) {
    writeStoredOpen(true);
    return;
  }
  // Read the actual stored state — the sibling plugin may have closed this
  // rail via closeSiblingRail() while `currentOpen` was stale (that path
  // only writes localStorage + dispatches an event; it doesn't touch this
  // module's cache). Reading from storage here ensures a single click always
  // toggles in the correct direction.
  const currentlyOpen = readStoredOpen(false);
  writeStoredOpen(!currentlyOpen);
}
