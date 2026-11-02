/**
 * Schemas, types, and constants used by both server and frontend.
 * No BB SDK imports — this module is safe for the browser bundle.
 */
import { z } from "zod";

export const SKIP_FILE_NAMES: Record<string, true> = { ".DS_Store": true };

export const treeEntrySchema = z.object({
  name: z.string(),
  relativePath: z.string(),
  kind: z.enum(["file", "directory"]),
  /**
   * Matched by a `.gitignore` rule — the repo's own or the user's global
   * excludes file. Absent for rows the client synthesised (a revealed child
   * the host never listed), which are shown undimmed.
   */
  gitIgnored: z.boolean().optional(),
});
export type TreeEntry = z.infer<typeof treeEntrySchema>;

export const gitStatusEntrySchema = z.object({
  /** Relative to the explorer root. */
  path: z.string(),
  status: z.enum(["conflicted", "deleted", "modified", "renamed", "added", "untracked"]),
  /** The index differs from HEAD (staged). Absent on branch entries. */
  staged: z.boolean().optional(),
  /** The working tree differs from the index, or the file is untracked. */
  unstaged: z.boolean().optional(),
});

export const gitStatusResultSchema = z.object({
  /** False outside a work tree, or on a machine without git. */
  isRepository: z.boolean(),
  entries: z.array(gitStatusEntrySchema),
  /** The repository had more changes than the explorer colours. */
  truncated: z.boolean(),
  /**
   * Files the branch's commits changed since it left the default branch
   * (merge-base..HEAD). Null on the default branch itself or without a remote.
   */
  branch: z.object({
    base: z.string(),
    commits: z.number().int().nonnegative(),
    entries: z.array(gitStatusEntrySchema),
    /** Set when the files are the thread's pull request, fetched from GitHub, because the checkout itself sits on the default branch. */
    pullRequest: z.number().int().positive().nullable().optional(),
  }).nullable().optional(),
});
export type GitStatusResult = z.infer<typeof gitStatusResultSchema>;

export const workspaceSchema = z.object({
  /**
   * Null when the root on screen is not this thread's environment — a reveal
   * that landed in another registered project re-roots the tree there.
   */
  environmentId: z.string().nullable(),
  hostId: z.string(),
  rootPath: z.string(),
  rootName: z.string(),
  /**
   * Opaque id the server minted for {hostId, rootPath}. `listDir` and
   * `revealInExplorer` take this instead of the raw
   * pair, so the server — not whatever called the RPC — decides which host
   * and path an operation actually touches.
   */
  rootId: z.string(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const rootChoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  projectId: z.string().nullable(),
  workspace: workspaceSchema,
});
export type RootChoice = z.infer<typeof rootChoiceSchema>;

export const workspaceResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    workspace: workspaceSchema,
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["no_thread", "no_environment", "no_checkout"]),
  }),
]);
export type WorkspaceResult = z.infer<typeof workspaceResultSchema>;

/** Where a reveal landed, when that is not the thread's own workspace. */
export const revealRootSchema = z.object({
  hostId: z.string(),
  rootPath: z.string(),
  rootName: z.string(),
  rootId: z.string(),
});
export type RevealRoot = z.infer<typeof revealRootSchema>;

export const revealResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    relativePath: z.string(),
    isDirectory: z.boolean(),
    /**
     * Set when the path lives in another registered project. Agents cite
     * paths from anywhere, so the tree re-roots there rather than reporting
     * a path the user can plainly see is real.
     */
    root: revealRootSchema.nullable(),
  }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);
export type RevealResult = z.infer<typeof revealResultSchema>;

/**
 * One row in the find-a-file list: enough to draw it, and the absolute path a
 * click hands back to the same reveal that chat paths use.
 */
export const searchHitSchema = z.object({
  name: z.string(),
  /** Relative to the root named below, so a row can show where the file lives. */
  relativePath: z.string(),
  absolutePath: z.string(),
  rootName: z.string(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

/**
 * One line inside a file that matched a text query: enough to draw the row
 * (file, line number, and the slice of the line to highlight) without sending
 * the whole file back.
 */
export const fileSearchMatchSchema = z.object({
  relativePath: z.string(),
  name: z.string(),
  /** 1-based, as an editor shows it. */
  line: z.number().int().positive(),
  /** The line, trimmed of its newline; long lines are clipped for transport. */
  text: z.string(),
  /** 0-based offset of the first match within `text`. */
  column: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
  /** Every match on this line, so a row can say "3" without re-scanning. */
  lineMatches: z.number().int().positive(),
});
export type FileSearchMatch = z.infer<typeof fileSearchMatchSchema>;

/** One file's outcome from a replace run. */
export const fileReplaceOutcomeSchema = z.object({
  relativePath: z.string(),
  replaced: z.number().int().nonnegative(),
});
export type FileReplaceOutcome = z.infer<typeof fileReplaceOutcomeSchema>;

/**
 * A chat link bb aimed at a file that is not there, and the file the same text
 * really names. `text` and `href` identify the anchor the fix belongs to.
 */
export const anchorFixSchema = z.object({
  text: z.string(),
  href: z.string(),
  absolutePath: z.string(),
  hostId: z.string(),
  isDirectory: z.boolean(),
});
export type AnchorFix = z.infer<typeof anchorFixSchema>;
