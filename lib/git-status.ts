/**
 * Git working-tree status, the way VS Code's explorer shows it: one state per
 * changed file, and a folder takes on the most important state beneath it.
 */
export type GitFileStatus =
  | "conflicted"
  | "deleted"
  | "modified"
  | "renamed"
  | "added"
  | "untracked";

export interface GitStatusEntry {
  path: string;
  status: GitFileStatus;
  staged?: boolean;
  unstaged?: boolean;
  /** Lines added and deleted; absent when unknown or binary. */
  additions?: number;
  deletions?: number;
  /** Git sees the file as binary: changed, with no lines to count. */
  binary?: boolean;
}

export type LineCounts = Pick<GitStatusEntry, "additions" | "deletions" | "binary">;

/**
 * Parse `git diff --numstat -z`: "added\tdeleted\tpath", or for a rename
 * "added\tdeleted\t" followed by the old and the new path. A binary file reads
 * "-\t-". Keyed by the (new) path as git printed it.
 */
export function parseNumstatZ(output: string): Map<string, LineCounts> {
  const fields = output.split("\0");
  const counts = new Map<string, LineCounts>();
  for (let index = 0; index < fields.length; index += 1) {
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/u.exec(fields[index]!);
    if (match === null) continue;
    let path = match[3]!;
    if (path === "") path = fields[(index += 2)] ?? "";
    if (path === "") continue;
    counts.set(path, match[1] === "-" || match[2] === "-"
      ? { binary: true }
      : { additions: Number(match[1]), deletions: Number(match[2]), binary: false });
  }
  return counts;
}

/** Entries with the line counts known for their paths; others stay without. */
export function withLineCounts(
  entries: readonly GitStatusEntry[],
  counts: ReadonlyMap<string, LineCounts>,
): GitStatusEntry[] {
  return entries.map((entry) => {
    const known = counts.get(entry.path);
    return known === undefined ? entry : { ...entry, ...known };
  });
}

/** Lines in a text file's content as git counts them for a new file; null for binary content. */
export function countLines(content: Uint8Array): number | null {
  // Git's own test: a NUL byte in the first 8000 bytes makes a file binary.
  if (content.subarray(0, 8000).includes(0)) return null;
  let lines = 0;
  for (const byte of content) if (byte === 10) lines += 1;
  if (content.length > 0 && content[content.length - 1] !== 10) lines += 1;
  return lines;
}

/** Most important first: a folder shows the highest-ranked state inside it. */
const PRIORITY: readonly GitFileStatus[] = [
  "conflicted",
  "deleted",
  "modified",
  "renamed",
  "added",
  "untracked",
];

export function morePressing(
  left: GitFileStatus | undefined,
  right: GitFileStatus,
): GitFileStatus {
  if (left === undefined) return right;
  return PRIORITY.indexOf(left) <= PRIORITY.indexOf(right) ? left : right;
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function statusFor(code: string): GitFileStatus | null {
  if (code === "??") return "untracked";
  if (code === "!!") return null;
  if (CONFLICT_CODES.has(code)) return "conflicted";
  const index = code[0]!;
  const worktree = code[1]!;
  if (index === "D" || worktree === "D") return "deleted";
  if (index === "R" || index === "C") return "renamed";
  if (index === "A") return "added";
  return "modified";
}

/**
 * Parse `git status --porcelain=v1 -z`. Paths in that format are relative to
 * the repository's top level; `prefix` (from `git rev-parse --show-prefix`)
 * re-bases them onto the browsed directory, and drops changes outside it.
 */
export function parsePorcelainZ(output: string, prefix: string): GitStatusEntry[] {
  const records = output.split("\0");
  const entries: GitStatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const repoPath = record.slice(3);
    // A rename or copy carries its original path as the next record.
    if (code[0] === "R" || code[0] === "C") index += 1;

    const status = statusFor(code);
    if (status === null) continue;
    if (prefix !== "" && !repoPath.startsWith(prefix)) continue;
    const path = repoPath.slice(prefix.length).replace(/\/+$/, "");
    if (path === "") continue;
    entries.push({ path, status, staged: code[0] !== " " && code[0] !== "?", unstaged: code[1] !== " " });
  }

  return entries;
}

/**
 * Parse `git diff --name-status -z --relative`: a status letter (with a score
 * for renames and copies), then the path, or the old and new path.
 */
export function parseNameStatusZ(output: string): GitStatusEntry[] {
  const fields = output.split("\0");
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const letter = fields[index]![0];
    if (letter === undefined) continue;
    const path = letter === "R" || letter === "C" ? fields[(index += 2)] : fields[(index += 1)];
    if (path === undefined || path === "") continue;
    const status: GitFileStatus = letter === "A" ? "added"
      : letter === "D" ? "deleted"
      : letter === "R" || letter === "C" ? "renamed"
      : letter === "U" ? "conflicted"
      : "modified";
    entries.push({ path, status });
  }
  return entries;
}

/**
 * Index every changed file and every directory above one, so the tree can
 * colour a row with a single lookup.
 */
export function indexStatuses(
  entries: readonly GitStatusEntry[],
): Map<string, GitFileStatus> {
  const byPath = new Map<string, GitFileStatus>();
  for (const { path, status } of entries) {
    byPath.set(path, morePressing(byPath.get(path), status));
    let separator = path.lastIndexOf("/");
    while (separator > 0) {
      const directory = path.slice(0, separator);
      const current = byPath.get(directory);
      const next = morePressing(current, status);
      // An ancestor that already outranks this change outranks it for every
      // directory above, too.
      if (current === next && current !== undefined) break;
      byPath.set(directory, next);
      separator = directory.lastIndexOf("/");
    }
  }
  return byPath;
}

/** The letter VS Code puts at the end of a changed file's row. */
export const STATUS_BADGE: Record<GitFileStatus, string> = {
  conflicted: "!",
  deleted: "D",
  modified: "M",
  renamed: "R",
  added: "A",
  untracked: "U",
};

export const STATUS_LABEL: Record<GitFileStatus, string> = {
  conflicted: "Conflicted",
  deleted: "Deleted",
  modified: "Modified",
  renamed: "Renamed",
  added: "Added",
  untracked: "Untracked",
};

/**
 * Tailwind text colours for a changed row, after VS Code's Git decorations:
 * amber for modified, green for new, red for deleted, purple for conflicts.
 */
export const STATUS_TEXT: Record<GitFileStatus, string> = {
  conflicted: "text-purple-500 dark:text-purple-400",
  deleted: "text-red-600 dark:text-red-400",
  modified: "text-amber-600 dark:text-amber-400",
  renamed: "text-amber-600 dark:text-amber-400",
  added: "text-green-600 dark:text-green-400",
  untracked: "text-green-600 dark:text-green-400",
};
