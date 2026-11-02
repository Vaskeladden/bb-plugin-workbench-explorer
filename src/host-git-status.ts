import { execFile } from "node:child_process";
import { parseNameStatusZ, parsePorcelainZ, type GitStatusEntry } from "../lib/git-status";

/** A repository with this many changes is past what a tree can usefully colour. */
const MAX_ENTRIES = 5000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

export interface HostGitStatus {
  /** False outside a work tree, or on a machine without git. */
  isRepository: boolean;
  entries: GitStatusEntry[];
  truncated: boolean;
  branch?: HostBranchChanges | null;
}

export interface HostBranchChanges {
  /** The default branch the comparison runs against, e.g. "main". */
  base: string;
  commits: number;
  entries: GitStatusEntry[];
}

function git(cwd: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { maxBuffer: MAX_OUTPUT_BYTES, timeout: TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error === null ? stdout : null),
    );
  });
}

/**
 * The working-tree status of the repository `rootPath` sits in, re-based onto
 * `rootPath`. The root can be a subdirectory of the repository — a monorepo
 * package pinned as a project — so changes outside it are dropped.
 */
export async function hostGitStatus(rootPath: string): Promise<HostGitStatus> {
  const prefixOutput = await git(rootPath, ["rev-parse", "--show-prefix"]);
  if (prefixOutput === null) return { isRepository: false, entries: [], truncated: false };
  const prefix = prefixOutput.trim();
  // Every untracked file, not just its top folder, so a new file deep in a new
  // folder is coloured where it is.
  const status = await git(rootPath, [
    "--no-optional-locks",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (status === null) return { isRepository: true, entries: [], truncated: false };
  const entries = parsePorcelainZ(status, prefix);
  return {
    isRepository: true,
    entries: entries.slice(0, MAX_ENTRIES),
    truncated: entries.length > MAX_ENTRIES,
    branch: await hostBranchChanges(rootPath).catch(() => null),
  };
}

/** The remote default branch (origin/HEAD), falling back to main. */
async function defaultBase(rootPath: string): Promise<string> {
  const ref = (await git(rootPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))?.trim();
  return ref !== undefined && ref !== "" ? ref.replace(/^origin\//u, "") : "main";
}

async function mergeBase(rootPath: string, base: string): Promise<string | null> {
  return (await git(rootPath, ["merge-base", "HEAD", `origin/${base}`]))?.trim() || null;
}

/**
 * What the branch's commits changed since it left the default branch, as a
 * pull request would show it: merge-base..HEAD, limited to the root.
 * Uncommitted work is the status list's business, not this one's.
 */
export async function hostBranchChanges(rootPath: string): Promise<HostBranchChanges | null> {
  const base = await defaultBase(rootPath);
  const current = (await git(rootPath, ["branch", "--show-current"]))?.trim();
  if (current === base) return null;
  const fork = await mergeBase(rootPath, base);
  if (fork === null) return null;
  const count = Number((await git(rootPath, ["rev-list", "--count", `${fork}..HEAD`]))?.trim() ?? "0");
  if (count === 0) return { base, commits: 0, entries: [] };
  const output = await git(rootPath, [
    "--no-optional-locks", "diff", "--name-status", "-z", "--find-renames", "--relative", fork, "HEAD",
  ]);
  return { base, commits: Number.isFinite(count) ? count : 0, entries: parseNameStatusZ(output ?? "").slice(0, MAX_ENTRIES) };
}

/** A diff past this size is not worth drawing in a panel. */
const MAX_PATCH_BYTES = 2 * 1024 * 1024;

/**
 * The uncommitted change to one file as a unified patch: against HEAD for a
 * tracked file, against nothing for an untracked one. Null when there is no
 * change to show, or the patch is too large.
 */
export async function hostGitDiff(rootPath: string, relativePath: string, against: "head" | "base" = "head"): Promise<string | null> {
  if (against === "base") {
    // The file as the branch's commits changed it since the default branch.
    const fork = await mergeBase(rootPath, await defaultBase(rootPath));
    if (fork === null) return null;
    const patch = await git(rootPath, [
      "--no-optional-locks", "diff", "--no-color", "--no-ext-diff", "--find-renames", fork, "HEAD", "--", relativePath,
    ]);
    if (patch === null || patch.trim() === "" || patch.length > MAX_PATCH_BYTES) return null;
    return patch;
  }
  // A tracked file — modified, staged, or deleted — differs from HEAD; an
  // untracked one does not exist there, so diff it against nothing.
  let patch = await git(rootPath, ["--no-optional-locks", "diff", "--no-color", "--no-ext-diff", "HEAD", "--", relativePath]);
  if (patch === null || patch.trim() === "") patch = await gitNoIndex(rootPath, relativePath);
  if (patch === null || patch.trim() === "" || patch.length > MAX_PATCH_BYTES) return null;
  return patch;
}

/** `git diff --no-index` exits 1 when the sides differ, which is the answer. */
function gitNoIndex(cwd: string, relativePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", relativePath],
      { maxBuffer: MAX_OUTPUT_BYTES, timeout: TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error === null || (error as { code?: unknown }).code === 1 ? stdout : null),
    );
  });
}

export type GitAction = "stage" | "unstage" | "discard";

interface RawChange {
  /** Porcelain index and worktree letters. */
  index: string;
  worktree: string;
  /** Repository-relative, as git status prints them. */
  path: string;
  origPath: string | null;
}

function rawChanges(output: string): RawChange[] {
  const records = output.split("\0");
  const changes: RawChange[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    if (record.length < 4) continue;
    const index = record[0]!;
    const worktree = record[1]!;
    const origPath = index === "R" || index === "C" ? records[(i += 1)] ?? null : null;
    changes.push({ index, worktree, path: record.slice(3), origPath });
  }
  return changes;
}

/**
 * Stage, unstage or discard files under the root. Only files the current
 * `git status` lists are touched, so a stale or crafted request cannot reach
 * anything else in the checkout. Commands run at the repository top level on
 * repository-relative paths, so a root inside a monorepo works the same.
 */
export async function hostGitAction(
  rootPath: string,
  action: GitAction,
  relativePaths: readonly string[],
): Promise<{ ok: boolean; message: string }> {
  const top = (await git(rootPath, ["rev-parse", "--show-toplevel"]))?.trim();
  const prefix = (await git(rootPath, ["rev-parse", "--show-prefix"]))?.trim() ?? "";
  if (!top) return { ok: false, message: "This folder is not in a git repository." };
  const status = await git(top, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status === null) return { ok: false, message: "git status failed." };
  const listed = new Map(rawChanges(status).map((change) => [change.path, change]));
  const changes = relativePaths
    .map((path) => listed.get(prefix + path))
    .filter((change): change is RawChange => change !== undefined);
  if (changes.length === 0) return { ok: false, message: "Those files no longer have changes." };
  const noun = `${changes.length} file${changes.length === 1 ? "" : "s"}`;
  const run = async (args: string[]) => {
    const failure = await gitError(top, args);
    if (failure !== null) throw new Error(failure);
  };
  try {
    if (action === "stage") {
      await run(["add", "-A", "--", ...changes.map((c) => c.path)]);
      return { ok: true, message: `Staged ${noun}.` };
    }
    if (action === "unstage") {
      const staged = changes.filter((c) => c.index !== " " && c.index !== "?");
      if (staged.length > 0) {
        await run(["restore", "--staged", "--", ...staged.flatMap((c) => (c.origPath ? [c.origPath, c.path] : [c.path]))]);
      }
      return { ok: true, message: `Unstaged ${noun}.` };
    }
    // Discard: put every file back the way HEAD has it.
    const untracked = changes.filter((c) => c.index === "?");
    const added = changes.filter((c) => c.index === "A" || c.index === "R" || c.index === "C");
    const tracked = changes.filter((c) => c.index !== "?" && c.index !== "A");
    if (untracked.length > 0) await run(["clean", "-f", "-q", "--", ...untracked.map((c) => c.path)]);
    if (added.length > 0) {
      // New in the index, or the new side of a rename: drop it from the index and the disk.
      await run(["rm", "-q", "-f", "--cached", "--", ...added.map((c) => c.path)]);
      await run(["clean", "-f", "-q", "--", ...added.map((c) => c.path)]);
    }
    const restore = tracked.flatMap((c) => (c.origPath ? [c.origPath] : c.index === "R" || c.index === "C" ? [] : [c.path]));
    if (restore.length > 0) await run(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...restore]);
    return { ok: true, message: `Discarded changes in ${noun}.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Null on success, else git's last stderr lines. */
function gitError(cwd: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { maxBuffer: MAX_OUTPUT_BYTES, timeout: 30_000, windowsHide: true },
      (error, _stdout, stderr) =>
        resolve(error === null ? null : (String(stderr).trim().split("\n").slice(-3).join(" ") || error.message).slice(0, 400)),
    );
  });
}
