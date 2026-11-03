import assert from "node:assert/strict";
import { test } from "bun:test";
import { branchEntries, type BbGitFile } from "./bb-git";

const file = (path: string, changeKind: BbGitFile["changeKind"]): BbGitFile => ({ path, changeKind, revision: "r" });

test("bb--git's repository paths are re-based onto a root inside the repository", () => {
  const files = [
    file("pkg/src/a.ts", "modified"),
    file("pkg/new.ts", "added"),
    file("pkg/old.ts", "deleted"),
    file("pkg/moved.ts", "renamed"),
    file("pkg/copy.ts", "copied"),
    file("pkg/link", "type_changed"),
    file("pkgx/other.ts", "modified"),
    file("top.ts", "modified"),
  ];
  assert.deepEqual(branchEntries(files, "pkg/").map((entry) => `${entry.status} ${entry.path}`), [
    "modified src/a.ts",
    "added new.ts",
    "deleted old.ts",
    "renamed moved.ts",
    "renamed copy.ts",
    "modified link",
  ]);
  assert.equal(branchEntries(files, "").length, files.length);
});

test("bb--git's line counts ride along; a binary file's zeros are no count", () => {
  const files: BbGitFile[] = [
    { ...file("pkg/a.ts", "modified"), additions: 33, deletions: 1, binary: false },
    { ...file("pkg/logo.png", "added"), additions: 0, deletions: 0, binary: true },
    file("pkg/old-host.ts", "modified"),
  ];
  assert.deepEqual(branchEntries(files, "pkg/"), [
    { path: "a.ts", status: "modified", additions: 33, deletions: 1, binary: false },
    { path: "logo.png", status: "added", binary: true },
    { path: "old-host.ts", status: "modified" },
  ]);
});
