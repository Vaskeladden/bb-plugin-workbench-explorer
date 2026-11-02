import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { fileSearchMatchSchema, gitStatusResultSchema, treeEntrySchema } from "./shared";

export const hostContract = defineRpcContract({
  statPath: {
    input: z.object({ rootPath: z.string().min(1), relativePath: z.string() }).strict(),
    output: z.object({ isDirectory: z.boolean() }).strict().nullable(),
  },
  listDirectory: {
    input: z.object({
      rootPath: z.string().min(1),
      relativePath: z.string(),
      showSkipped: z.boolean(),
      ignoredFolders: z.array(z.string()),
    }).strict(),
    output: z.object({ entries: z.array(treeEntrySchema) }).strict(),
  },
  /**
   * Text search inside a root, run on the machine that owns it: the files never
   * cross the host bridge, and a root on another paired host searches there.
   */
  searchInFiles: {
    input: z.object({
      rootPath: z.string().min(1),
      query: z.string().min(1).max(1024),
      matchCase: z.boolean(),
      wholeWord: z.boolean(),
      useRegex: z.boolean(),
      limit: z.number().int().min(1).max(1000),
      ignoredFolders: z.array(z.string()).max(200),
      include: z.string(),
      /** Comma-separated globs the search skips. */
      exclude: z.string(),
    }).strict(),
    output: z.object({
      matches: z.array(fileSearchMatchSchema),
      /** True when the match budget stopped the run before the tree was exhausted. */
      truncated: z.boolean(),
      filesWithMatches: z.number().int().nonnegative(),
    }).strict(),
  },
  /** Working-tree status, run with the machine's own git where the root lives. */
  gitStatus: {
    input: z.object({
      rootPath: z.string().min(1),
      /** The thread's pull request, compared with the default branch when the checkout is on it. */
      pullRequest: z.object({ repo: z.string().min(3), number: z.number().int().positive() }).strict().optional(),
    }).strict(),
    output: gitStatusResultSchema,
  },
  gitDiff: {
    input: z.object({ rootPath: z.string().min(1), relativePath: z.string().min(1), against: z.enum(["head", "base"]).optional(), pullRequest: z.number().int().positive().optional() }).strict(),
    output: z.object({ patch: z.string().nullable() }).strict(),
  },
  /** Stage, unstage or discard files `git status` lists under the root. */
  gitAction: {
    input: z.object({
      rootPath: z.string().min(1),
      action: z.enum(["stage", "unstage", "discard"]),
      relativePaths: z.array(z.string().min(1)).min(1).max(2000),
    }).strict(),
    output: z.object({ ok: z.boolean(), message: z.string() }).strict(),
  },
  /** Move to this machine's Trash; `trashedPath` is null where there is none and the delete was permanent. */
  trashPath: {
    input: z.object({ rootPath: z.string().min(1), relativePath: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), trashedPath: z.string().nullable() }).strict(),
  },
  /** Undo a trash: move `trashedPath` back to `relativePath`, never overwriting. */
  restorePath: {
    input: z.object({ rootPath: z.string().min(1), relativePath: z.string().min(1), trashedPath: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), message: z.string().nullable() }).strict(),
  },
  /** Copy into a folder under a free name ("name copy", "name copy 2", …). */
  copyPath: {
    input: z.object({ rootPath: z.string().min(1), relativePath: z.string().min(1), destinationDirectory: z.string() }).strict(),
    output: z.object({ ok: z.boolean(), relativePath: z.string().nullable(), message: z.string().nullable() }).strict(),
  },
  /** Which of these root-relative paths git ignores; empty outside a repository. */
  ignoredPaths: {
    input: z.object({ rootPath: z.string().min(1), relativePaths: z.array(z.string()).max(1000) }).strict(),
    output: z.object({ ignored: z.array(z.string()) }).strict(),
  },
  removePath: {
    input: z.object({
      rootPath: z.string().min(1),
      relativePath: z.string(),
    }).strict(),
    output: z.object({ ok: z.boolean() }).strict(),
  },
});
