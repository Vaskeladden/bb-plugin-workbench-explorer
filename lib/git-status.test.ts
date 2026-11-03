import assert from "node:assert/strict";
import { test } from "bun:test";
import { countLines, parseNumstatZ, withLineCounts } from "./git-status";

test("numstat -z: plain, renamed and binary files", () => {
  const output = ["12\t3\tsrc/a.ts", "4\t0\t", "old/name.ts", "new/name.ts", "-\t-\tlogo.png", ""].join("\0");
  assert.deepEqual([...parseNumstatZ(output)], [
    ["src/a.ts", { additions: 12, deletions: 3, binary: false }],
    ["new/name.ts", { additions: 4, deletions: 0, binary: false }],
    ["logo.png", { binary: true }],
  ]);
  assert.equal(parseNumstatZ("").size, 0);
});

test("counts attach by path and leave unknown files without", () => {
  const entries = withLineCounts(
    [{ path: "a.ts", status: "modified" }, { path: "b.ts", status: "added" }],
    new Map([["a.ts", { additions: 1, deletions: 2, binary: false }]]),
  );
  assert.deepEqual(entries, [
    { path: "a.ts", status: "modified", additions: 1, deletions: 2, binary: false },
    { path: "b.ts", status: "added" },
  ]);
});

test("a new file's lines count as git counts them", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  assert.equal(countLines(bytes("")), 0);
  assert.equal(countLines(bytes("one\n")), 1);
  assert.equal(countLines(bytes("one\ntwo")), 2);
  assert.equal(countLines(new Uint8Array([65, 0, 66])), null);
});
