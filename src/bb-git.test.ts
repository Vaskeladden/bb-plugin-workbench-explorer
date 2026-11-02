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
