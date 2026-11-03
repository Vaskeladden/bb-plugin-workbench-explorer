import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
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
    assert.deepEqual(await hostGitStatus(dir), { isRepository: false, entries: [], truncated: false });
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
    assert.deepEqual(changes, { base: "trunk", commits: 1, entries: [{ path: "a.ts", status: "modified", additions: 1, deletions: 1, binary: false }], pullRequest: null });
    assert.match((await hostGitDiff(path.join(dir, "pkg"), "a.ts", "base", { base: "trunk" })) ?? "", /-one\n\+two/u);
    // On the base branch with no pull request there is nothing to compare.
    git("checkout", "-q", "trunk");
    assert.equal(await hostBranchChanges(dir, "trunk"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
