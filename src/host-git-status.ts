import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  countLines,
  parseNameStatusZ,
  parseNumstatZ,
  parsePorcelainZ,
  withLineCounts,
  type GitStatusEntry,
  type LineCounts,
} from "../lib/git-status";
import { mapLimit } from "./pool";

/** A repository with this many changes is past what a tree can usefully colour. */
const MAX_ENTRIES = 5000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

export interface HostGitStatus {
  /** False outside a work tree, or on a machine without git. */
  isRepository: boolean;
  entries: GitStatusEntry[];
  truncated: boolean;
}

export interface HostBranchChanges {
  /** The branch the comparison runs against, e.g. "main". */
  base: string;
  commits: number;
  entries: GitStatusEntry[];
  pullRequest?: number | null;
}

export interface PullRequestRef {
  /** owner/name on GitHub. */
  repo: string;
  number: number;
}

/** Where a fetched pull request head is kept; never a branch, so nothing checks it out. */
function pullRequestRef(number: number): string {
  return `refs/bb-explorer/pr/${number}`;
}

const PR_FETCH_MS = 60_000;
const pullRequestFetchedAt = new Map<string, number>();

async function refExists(rootPath: string, ref: string): Promise<boolean> {
  return (await git(rootPath, ["rev-parse", "--verify", "--quiet", ref])) !== null;
}

/**
 * Keep `refs/bb-explorer/pr/<n>` at the pull request's head, fetched from
 * GitHub's refs/pull/<n>/head at most once a minute. Only when origin is the
 * pull request's repository. True when the ref is there to compare.
 */
async function ensurePullRequestRef(rootPath: string, pr: PullRequestRef): Promise<boolean> {
  const origin = (await git(rootPath, ["remote", "get-url", "origin"]))?.trim().toLowerCase().replace(/\.git$/u, "") ?? "";
  const slug = pr.repo.toLowerCase();
  if (!(origin.endsWith(`/${slug}`) || origin.endsWith(`:${slug}`))) return false;
  const ref = pullRequestRef(pr.number);
  const exists = await refExists(rootPath, ref);
  const key = `${origin}#${pr.number}`;
  if (Date.now() - (pullRequestFetchedAt.get(key) ?? 0) > PR_FETCH_MS) {
    pullRequestFetchedAt.set(key, Date.now());
    const fetching = gitLong(rootPath, ["fetch", "--quiet", "--no-tags", "origin", `+refs/pull/${pr.number}/head:${ref}`]);
    // The first time, wait for it; after that the list shows the last fetch
    // while the next one runs.
    if (!exists) await fetching;
  }
  return exists || refExists(rootPath, ref);
}

function gitLong(cwd: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { maxBuffer: MAX_OUTPUT_BYTES, timeout: 60_000, windowsHide: true },
      (error, stdout) => resolve(error === null ? stdout : null));
  });
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
export async function hostGitStatus(
  rootPath: string,
  options: { lineCounts?: boolean } = {},
): Promise<HostGitStatus> {
  const prefix = await hostGitPrefix(rootPath);
  if (prefix === null) return { isRepository: false, entries: [], truncated: false };
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
  const parsed = parsePorcelainZ(status, prefix);
  const listed = parsed.slice(0, MAX_ENTRIES);
  const entries = options.lineCounts === true ? await uncommittedLineCounts(rootPath, prefix, listed) : listed;
  return { isRepository: true, entries, truncated: parsed.length > MAX_ENTRIES };
}

/** Untracked files past these bounds keep no count rather than slow the poll. */
const MAX_COUNTED_UNTRACKED = 500;
const MAX_COUNTED_BYTES = 2 * 1024 * 1024;

/**
 * Each change's added and deleted lines against HEAD, as `git diff HEAD`
 * counts them; an untracked file counts all its lines as added. For a root
 * that is no bb environment; bb--git counts them for one that is.
 */
async function uncommittedLineCounts(
  rootPath: string,
  prefix: string,
  entries: readonly GitStatusEntry[],
): Promise<GitStatusEntry[]> {
  const counts = new Map<string, LineCounts>();
  const numstat = await git(rootPath, ["--no-optional-locks", "diff", "--numstat", "-z", "HEAD"]);
  for (const [repoPath, known] of parseNumstatZ(numstat ?? "")) {
    if (repoPath.startsWith(prefix)) counts.set(repoPath.slice(prefix.length), known);
  }
  const untracked = entries.filter((entry) => entry.status === "untracked").slice(0, MAX_COUNTED_UNTRACKED);
  await mapLimit(untracked, 16, async (entry) => {
    const known = await untrackedLineCount(path.join(rootPath, entry.path));
    if (known !== null) counts.set(entry.path, known);
  });
  return withLineCounts(entries, counts);
}

async function untrackedLineCount(filePath: string): Promise<LineCounts | null> {
  try {
    // A symlink, FIFO or device keeps no count: reading one could block or leave the root.
    const stat = await lstat(filePath);
    if (!stat.isFile() || stat.size > MAX_COUNTED_BYTES) return null;
    const lines = countLines(await readFile(filePath));
    return lines === null ? { binary: true } : { additions: lines, deletions: 0, binary: false };
  } catch {
    // Gone since git status listed it.
    return null;
  }
}

/** Where `rootPath` sits in its repository ("" at the top, "pkg/" below it); null outside one. */
export async function hostGitPrefix(rootPath: string): Promise<string | null> {
  return (await git(rootPath, ["rev-parse", "--show-prefix"]))?.trim() ?? null;
}

interface Comparison {
  base: string;
  /** HEAD, or the pull request's fetched head. */
  head: string;
  fork: string;
  pullRequest: number | null;
}

/**
 * What to compare, run with git only where bb--git cannot answer: a pull
 * request's head (bb--git compares an environment's own checkout, and a ref
 * fetched into refs/bb-explorer is no target it accepts) and a folder that is
 * no bb environment.
 *
 * `base` is the branch bb--git compares the environment with, resolved the way
 * bb--git does: the branch itself, else origin's copy. Null for a folder that
 * is no bb environment, which has no merge base of bb's to follow, so it keeps
 * comparing with origin's default branch (origin/HEAD, else main).
 *
 * `pr` resolves the head when the checkout sits on the base branch: a
 * reference to fetch (the Changes list) or the number of one already fetched
 * (a diff opened from it). Without one, such a checkout has nothing to compare.
 */
async function comparison(
  rootPath: string,
  base: string | null,
  pr: PullRequestRef | number | null,
): Promise<Comparison | null> {
  let name: string;
  let baseRef: string;
  if (base === null) {
    const remoteHead = (await git(rootPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))?.trim();
    name = remoteHead !== undefined && remoteHead !== "" ? remoteHead.replace(/^origin\//u, "") : "main";
    baseRef = `origin/${name}`;
  } else {
    name = base;
    baseRef = (await refExists(rootPath, base)) ? base : `origin/${base}`;
  }
  let head = "HEAD";
  let pullRequest: number | null = null;
  if (typeof pr === "number") {
    // A diff opened from the pull request's list reads the head that list fetched.
    if (await refExists(rootPath, pullRequestRef(pr))) {
      head = pullRequestRef(pr);
      pullRequest = pr;
    }
  } else if ((await git(rootPath, ["branch", "--show-current"]))?.trim() === name) {
    // A checkout on the base branch has no branch of its own to compare.
    // A thread that opened a pull request from it still has one: compare that.
    if (pr === null || !(await ensurePullRequestRef(rootPath, pr))) return null;
    head = pullRequestRef(pr.number);
    pullRequest = pr.number;
  }
  const fork = (await git(rootPath, ["merge-base", head, baseRef]))?.trim();
  return fork ? { base: name, head, fork, pullRequest } : null;
}

/**
 * What the commits changed since they left the base, as a pull request would
 * show it: merge-base..head, limited to the root. Uncommitted work is the
 * status list's business, not this one's.
 */
export async function hostBranchChanges(
  rootPath: string,
  base: string | null,
  pr: PullRequestRef | null = null,
): Promise<HostBranchChanges | null> {
  const compared = await comparison(rootPath, base, pr);
  if (compared === null) return null;
  const { fork, head, pullRequest } = compared;
  const count = Number((await git(rootPath, ["rev-list", "--count", `${fork}..${head}`]))?.trim() ?? "0");
  if (count === 0) return { base: compared.base, commits: 0, entries: [], pullRequest };
  const [output, numstat] = await Promise.all(["--name-status", "--numstat"].map((format) => git(rootPath, [
    "--no-optional-locks", "diff", format, "-z", "--find-renames", "--relative", fork, head,
  ])));
  const entries = withLineCounts(parseNameStatusZ(output ?? "").slice(0, MAX_ENTRIES), parseNumstatZ(numstat ?? ""));
  return {
    base: compared.base,
    commits: Number.isFinite(count) ? count : 0,
    entries,
    pullRequest,
  };
}

/** A diff past this size is not worth drawing in a panel. */
const MAX_PATCH_BYTES = 2 * 1024 * 1024;

/**
 * One file's change as a unified patch. "head": the uncommitted change,
 * against HEAD for a tracked file and against nothing for an untracked one.
 * "base": what the commits changed since the base, on the same terms as
 * `hostBranchChanges`. Null when there is no change to show, or the patch is
 * too large.
 */
export async function hostGitDiff(
  rootPath: string,
  relativePath: string,
  against: "head" | "base" = "head",
  options: { base?: string | null; pullRequest?: number | null } = {},
): Promise<string | null> {
  if (against === "base") {
    const compared = await comparison(rootPath, options.base ?? null, options.pullRequest ?? null);
    if (compared === null) return null;
    const patch = await git(rootPath, [
      "--no-optional-locks", "diff", "--no-color", "--no-ext-diff", "--find-renames", compared.fork, compared.head, "--", relativePath,
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
