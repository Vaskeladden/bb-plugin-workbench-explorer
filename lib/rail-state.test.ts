import assert from "node:assert/strict";
import { test } from "bun:test";
import { noteRailOpen, RAIL_EVENT, showThread, toggleRailOpen, writeStoredOpen } from "./rail-state";

const GIT_RAIL_EVENT = "bb-plugin-git:rail-open";
const GIT_RAIL_STORAGE_KEY = "bb-plugin-git:rail-open";
const SELF_RAIL_STORAGE_KEY = "bb-plugin-workbench-explorer:rail-open";

type Browser = { values: Map<string, string>; target: EventTarget; events: boolean[]; gitEvents: boolean[] };

/** Run `body` with a window and a localStorage of its own, on a page without a thread. */
function inBrowser(stored: Array<[string, string]>, body: (browser: Browser) => void): void {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>(stored);
  const target = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    },
  });
  // The module remembers the thread on screen between tests: start without one.
  showThread(null);
  for (const [key, value] of stored) values.set(key, value);
  const events: boolean[] = [];
  const gitEvents: boolean[] = [];
  target.addEventListener(RAIL_EVENT, (event) => { events.push((event as CustomEvent<boolean>).detail); });
  target.addEventListener(GIT_RAIL_EVENT, (event) => { gitEvents.push((event as CustomEvent<boolean>).detail); });
  try {
    body({ values, target, events, gitEvents });
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

test("a thread the rail was never opened in starts closed, whatever the window showed last", () => {
  inBrowser([[SELF_RAIL_STORAGE_KEY, "1"]], ({ values, events }) => {
    assert.equal(showThread("thr_a"), false);
    assert.deepEqual(events, [false]);
    assert.equal(values.get(SELF_RAIL_STORAGE_KEY), "0");
  });
});

test("each thread remembers its own rail", () => {
  inBrowser([], ({ values }) => {
    showThread("thr_a");
    writeStoredOpen(true);
    assert.equal(showThread("thr_b"), false);
    assert.equal(values.get(SELF_RAIL_STORAGE_KEY), "0");
    assert.equal(showThread("thr_a"), true);
    assert.equal(values.get(SELF_RAIL_STORAGE_KEY), "1");
    writeStoredOpen(false);
    showThread("thr_b");
    assert.equal(showThread("thr_a"), false);
  });
});

test("a page without a thread shows the rail closed and remembers nothing", () => {
  inBrowser([], () => {
    showThread("thr_a");
    writeStoredOpen(true);
    assert.equal(showThread(null), false);
    writeStoredOpen(true);
    assert.equal(showThread(null), false);
    assert.equal(showThread("thr_a"), true);
  });
});

test("a rail the sibling closed stays closed for that thread", () => {
  inBrowser([], ({ values, target }) => {
    showThread("thr_a");
    writeStoredOpen(true);
    // The sibling writes our key and dispatches our event; the rail's listener passes it on.
    values.set(SELF_RAIL_STORAGE_KEY, "0");
    target.dispatchEvent(new CustomEvent(RAIL_EVENT, { detail: false }));
    noteRailOpen(false);
    showThread("thr_b");
    assert.equal(showThread("thr_a"), false);
  });
});

test("only the latest threads are remembered, and unreadable storage counts as closed", () => {
  inBrowser([], ({ values }) => {
    for (let index = 0; index < 305; index += 1) {
      showThread(`thr_${index}`);
      writeStoredOpen(true);
    }
    assert.equal(showThread("thr_0"), false);
    assert.equal(showThread("thr_304"), true);
    values.set("bb-plugin-workbench-explorer:rail-open-threads", "{not json");
    assert.equal(showThread("thr_304"), false);
  });
});

test("first toggle opens the rail of a thread that starts closed", () => {
  inBrowser([], ({ values, events }) => {
    assert.equal(showThread("thr_a"), false);
    toggleRailOpen();
    assert.deepEqual(events, [false, true]);
    assert.equal(values.get(SELF_RAIL_STORAGE_KEY), "1");
    assert.equal(showThread("thr_a"), true);
  });
});

test("opening the file-explorer rail closes the sibling git rail", () => {
  inBrowser([[SELF_RAIL_STORAGE_KEY, "0"], [GIT_RAIL_STORAGE_KEY, "1"]], ({ values, gitEvents }) => {
    writeStoredOpen(true);
    assert.equal(values.get(SELF_RAIL_STORAGE_KEY), "1");
    assert.equal(values.get(GIT_RAIL_STORAGE_KEY), "0");
    assert.deepEqual(gitEvents, [false]);
  });
});

test("closing the file-explorer rail does not affect the sibling git rail", () => {
  inBrowser([[SELF_RAIL_STORAGE_KEY, "1"], [GIT_RAIL_STORAGE_KEY, "1"]], ({ values, gitEvents }) => {
    writeStoredOpen(false);
    assert.equal(values.get(SELF_RAIL_STORAGE_KEY), "0");
    assert.equal(values.get(GIT_RAIL_STORAGE_KEY), "1");
    assert.deepEqual(gitEvents, []);
  });
});

test("toggle after sibling closes the rail opens it (stale currentOpen)", () => {
  inBrowser([[SELF_RAIL_STORAGE_KEY, "1"], [GIT_RAIL_STORAGE_KEY, "0"]], ({ values, target, gitEvents }) => {
    // Open this rail (currentOpen = true, storage = "1").
    writeStoredOpen(true);
    assert.equal(values.get(SELF_RAIL_STORAGE_KEY), "1");
    // Simulate sibling closing this rail: writes "0" to our storage + dispatches
    // our event, but does NOT update currentOpen (stale = true).
    values.set(SELF_RAIL_STORAGE_KEY, "0");
    target.dispatchEvent(new CustomEvent(RAIL_EVENT, { detail: false }));
    // Toggle should read "0" from storage (not stale currentOpen) and OPEN.
    // Opening dispatches git event "false" a second time via closeSiblingRail.
    toggleRailOpen();
    assert.equal(values.get(SELF_RAIL_STORAGE_KEY), "1");
    assert.equal(values.get(GIT_RAIL_STORAGE_KEY), "0");
    assert.deepEqual(gitEvents, [false, false]);
  });
});
