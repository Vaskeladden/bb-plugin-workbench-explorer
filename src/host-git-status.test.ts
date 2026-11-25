import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { bbGitBranchEntries } from "./bb-git";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostBranchChanges, hostGitDiff, hostGitStatus } from "./host-git-status";

async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fe-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  await mkdir(path.join(dir, "pkg", "src"), { recursive: true });
  await writeFile(path.join(dir, "pkg", "src", "a.ts"), "one\n");
  await writeFile(path.join(dir, "pkg", "gone.ts"), "x\n");
  await writeFile(path.join(dir, "top.ts"), "top\n");
  git("add", ".");
  git("commit", "-qm", "init");
  await writeFile(path.join(dir, "pkg", "src", "a.ts"), "two\n");
  await rm(path.join(dir, "pkg", "gone.ts"));
  await mkdir(path.join(dir, "pkg", "new", "deep"), { recursive: true });
  await writeFile(path.join(dir, "pkg", "new", "deep", "b.ts"), "b\n");
  await writeFile(path.join(dir, "top.ts"), "changed\n");
  return dir;
}

test("status is re-based onto a root inside the repository", async () => {
  const dir = await repo();
  try {
    const status = await hostGitStatus(path.join(dir, "pkg"));
    assert.equal(status.isRepository, true);
    assert.deepEqual(
      status.entries.map((entry) => `${entry.status} ${entry.path}`).sort(),
      ["deleted gone.ts", "modified src/a.ts", "untracked new/deep/b.ts"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("line counts, asked for, cover tracked, untracked and binary files under the root", async () => {
  const dir = await repo();
  try {
    await writeFile(path.join(dir, "pkg", "new", "two.txt"), "a\nb\nno newline");
    await writeFile(path.join(dir, "pkg", "new", "blob.bin"), Buffer.from([1, 0, 2]));
    const status = await hostGitStatus(path.join(dir, "pkg"), { lineCounts: true });
    const counts = Object.fromEntries(status.entries.map((entry) => [
      entry.path,
      entry.binary ? "bin" : `+${entry.additions} -${entry.deletions}`,
    ]));
    assert.deepEqual(counts, {
      "gone.ts": "+0 -1",
      "src/a.ts": "+1 -1",
      "new/deep/b.ts": "+1 -0",
      "new/two.txt": "+3 -0",
      "new/blob.bin": "bin",
    });
    // Without the option (a bb environment, which bb--git counts) nothing is counted.
    const plain = await hostGitStatus(path.join(dir, "pkg"));
    assert.equal(plain.entries.some((entry) => entry.additions !== undefined || entry.binary !== undefined), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a folder outside any repository is not one", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fe-nogit-"));
  try {
    assert.deepEqual(await hostGitStatus(dir), { isRepository: false, entries: [], counts: { uncommitted: 0, branch: 0, total: 0 } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("diff covers modified, deleted, and untracked files", async () => {
  const dir = await repo();
  const root = path.join(dir, "pkg");
  try {
    assert.match((await hostGitDiff(root, "src/a.ts")) ?? "", /-one\n\+two/u);
    assert.match((await hostGitDiff(root, "gone.ts")) ?? "", /deleted file mode/u);
    assert.match((await hostGitDiff(root, "new/deep/b.ts")) ?? "", /new file mode[\s\S]*\+b/u);
    assert.equal(await hostGitDiff(root, "src/missing.ts"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("branch changes compare with the base bb--git names, local branch first", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fe-branch-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  try {
    git("init", "-q", "-b", "trunk");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    await mkdir(path.join(dir, "pkg"), { recursive: true });
    await writeFile(path.join(dir, "pkg", "a.ts"), "one\n");
    await writeFile(path.join(dir, "top.ts"), "top\n");
    git("add", ".");
    git("commit", "-qm", "init");
    git("checkout", "-qb", "feature");
    await writeFile(path.join(dir, "pkg", "a.ts"), "two\n");
    await writeFile(path.join(dir, "top.ts"), "changed\n");
    git("commit", "-qam", "change");
    const changes = await hostBranchChanges(path.join(dir, "pkg"), "trunk");
    assert.deepEqual(changes, { base: "trunk", commits: 1, entries: [{ path: "a.ts", status: "modified", additions: 1, deletions: 1, binary: false }], remainingPaths: [], pullRequest: null });
    assert.match((await hostGitDiff(path.join(dir, "pkg"), "a.ts", "base", { base: "trunk" })) ?? "", /-one\n\+two/u);
    // On the base branch with no pull request there is nothing to compare.
    git("checkout", "-q", "trunk");
    assert.equal(await hostBranchChanges(dir, "trunk"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a capped bb--git listing counts every branch path under the root and counts local overlaps once", async () => {
  const dir = await repo();
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  try {
    const base = git("rev-parse", "HEAD");
    const names = Array.from({ length: 501 }, (_, i) => `pkg/file-${String(i).padStart(3, "0")}`);
    for (const name of names) await writeFile(path.join(dir, name), "branch\n");
    git("add", ".");
    git("commit", "-qm", "large branch");
    const listed = names.slice(0, 500).map((path) => ({ path, changeKind: "added", revision: "r" }));
    const bb = { sdk: { plugins: { callRpc: ({ outputSchema }: { outputSchema: { parse(input: unknown): unknown } }) => outputSchema.parse({
      outcome: "available", files: listed, initialPatches: [], truncated: true, mergeBaseRef: base,
    }) } } } as unknown as BbPluginApi;
    const listing = await bbGitBranchEntries(bb, "env", "main", "pkg/");
    assert.ok(listing);
    assert.equal(listing.entries.length, 500);
    await writeFile(path.join(dir, names[500]!), "edited after commit\n");
    await writeFile(path.join(dir, "pkg", "local only\nfile"), "untracked\n");
    const status = await hostGitStatus(path.join(dir, "pkg"), { branchPaths: listing.paths });
    // repo() also changed three pkg files and one outside pkg before the commit.
    assert.deepEqual(status.counts, { branch: 504, uncommitted: 2, total: 505 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("local entries beyond the 5,000-row tree limit still contribute to the distinct count", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fe-dirty-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    const blob = execFileSync("git", ["-C", dir, "hash-object", "-w", "--stdin"], { input: "content", encoding: "utf8" }).trim();
    const names = Array.from({ length: 5001 }, (_, i) => `file-${String(i).padStart(4, "0")}`);
    execFileSync("git", ["-C", dir, "update-index", "--index-info"], {
      input: names.map((name) => `100644 ${blob}\t${name}\n`).join(""),
    });
    const status = await hostGitStatus(dir, { branchPaths: ["file-5000", "branch-only"] });
    assert.equal(status.entries.length, 5000);
    assert.deepEqual(status.counts, { branch: 2, uncommitted: 5001, total: 5002 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
