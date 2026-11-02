import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  anchorFixSchema,
  fileReplaceOutcomeSchema,
  fileSearchMatchSchema,
  gitStatusResultSchema,
  revealResultSchema,
  rootChoiceSchema,
  searchHitSchema,
  treeEntrySchema,
  workspaceResultSchema,
} from "./shared";

export const rpcContract = defineRpcContract({
  /**
   * Quick Open: files under a root by fuzzy name, leaving out what git
   * ignores (node_modules, build output), as VS Code does by default.
   */
  quickOpen: {
    input: z.object({ rootId: z.string().min(1), query: z.string().trim().min(1).max(1024), limit: z.number().int().min(1).max(100) }).strict(),
    output: z.object({ hits: z.array(searchHitSchema) }),
  },
  /** Uncommitted changes under a root, for colouring the tree and the Changes tab. */
  gitStatus: {
    input: z.object({ rootId: z.string().min(1) }).strict(),
    output: gitStatusResultSchema,
  },
  /** One file's uncommitted change as a unified patch; null when there is none. */
  /** Stage, unstage or discard uncommitted files under a root. */
  gitAction: {
    input: z.object({
      rootId: z.string().min(1),
      action: z.enum(["stage", "unstage", "discard"]),
      relativePaths: z.array(z.string().min(1).max(4096)).min(1).max(2000),
    }).strict(),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  gitDiff: {
    input: z.object({ rootId: z.string().min(1), relativePath: z.string().min(1).max(4096), against: z.enum(["head", "base"]).optional() }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), patch: z.string().nullable() }),
      z.object({ ok: z.literal(false), message: z.string() }),
    ]),
  },
  listRootChoices: {
    input: z.object({
      currentThreadId: z.string().min(1).nullable(),
      pinnedThreadId: z.string().min(1).nullable(),
    }).strict(),
    output: z.object({ choices: z.array(rootChoiceSchema) }),
  },
  resolveInRoot: {
    input: z.object({ rootId: z.string().min(1), path: z.string().trim().min(1).max(4096) }).strict(),
    output: revealResultSchema,
  },
  searchFilesInRoot: {
    input: z.object({ rootId: z.string().min(1), query: z.string().trim().min(1).max(1024), limit: z.number().int().min(1).max(50) }).strict(),
    output: z.object({ hits: z.array(searchHitSchema) }),
  },
  workspaceForThread: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: workspaceResultSchema,
  },
  workspaceForProject: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: workspaceResultSchema,
  },
  /** Turn a path as written in a chat message into a workspace-relative one. */
  resolveInWorkspace: {
    input: z
      .object({
        threadId: z.string().min(1),
        path: z.string().trim().min(1).max(4096),
      })
      .strict(),
    output: revealResultSchema,
  },
  /**
   * Which of these candidates are real paths in the thread's workspace.
   * `packs/gws` and `and/or` are the same shape, so the filesystem decides
   * which strings in a message get a reveal affordance.
   */
  /** Diagnostics from the browser, so DOM behaviour is observable in bb.log. */
  clientLog: {
    input: z.object({ message: z.string().max(2000) }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  resolvePaths: {
    input: z
      .object({
        threadId: z.string().min(1),
        paths: z.array(z.string().trim().min(1).max(4096)).max(200),
      })
      .strict(),
    output: z.object({ known: z.array(z.string()) }),
  },
  /**
   * Find a file by name or partial path across the thread workspace and the
   * search roots, favoring the active project. `resolveInWorkspace` is the
   * same question asked about a single written string.
   */
  searchFiles: {
    input: z
      .object({
        threadId: z.string().min(1),
        query: z.string().trim().min(1).max(1024),
        limit: z.number().int().min(1).max(50),
      })
      .strict(),
    output: z.object({ hits: z.array(searchHitSchema) }),
  },
  /**
   * Which of these chat links point at a file that does not exist, and where
   * the linked text actually lives. bb resolves a path written in a message
   * against the thread's own workspace root, so a message that names a file in
   * another project links to a path that was never there.
   */
  resolveFileAnchors: {
    input: z
      .object({
        threadId: z.string().min(1),
        anchors: z
          .array(
            z.object({
              text: z.string().trim().min(1).max(512),
              href: z.string().trim().min(1).max(4096),
            }),
          )
          .max(100),
      })
      .strict(),
    output: z.object({ fixes: z.array(anchorFixSchema) }),
  },
  listDir: {
    input: z
      .object({
        rootId: z.string().min(1),
        relativePath: z.string(),
        showSkipped: z.boolean(),
        ignoredFolders: z.array(z.string()),
      })
      .strict(),
    output: z.object({ entries: z.array(treeEntrySchema) }),
  },
  revealInExplorer: {
    input: z
      .object({
        rootId: z.string().min(1),
        relativePath: z.string(),
      })
      .strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), message: z.string() }),
    ]),
  },
  copyTextToClipboard: {
    input: z
      .object({
        rootId: z.string().min(1),
        text: z.string().max(10000),
      })
      .strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), message: z.string() }),
    ]),
  },
  /**
   * Create an empty file with a user-chosen name in the given folder and
   * return its workspace-relative path so the tree can select and open it.
   */
  createFile: {
    input: z
      .object({
        rootId: z.string().min(1),
        directoryRelativePath: z.string(),
        name: z.string().trim().min(1).max(4096),
      })
      .strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), relativePath: z.string() }),
      z.object({ ok: z.literal(false), message: z.string() }),
    ]),
  },
  /** Create a folder with a user-chosen name in the given folder. */
  createFolder: {
    input: z
      .object({
        rootId: z.string().min(1),
        directoryRelativePath: z.string(),
        name: z.string().trim().min(1).max(4096),
      })
      .strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), relativePath: z.string() }),
      z.object({ ok: z.literal(false), message: z.string() }),
    ]),
  },
  /** Delete one file or folder. The tree root is refused. */
  deleteEntry: {
    input: z
      .object({
        rootId: z.string().min(1),
        relativePath: z.string(),
      })
      .strict(),
    output: z.discriminatedUnion("ok", [
      /** `trashedPath` undoes the delete; null where the machine has no Trash and it was permanent. */
      z.object({ ok: z.literal(true), relativePath: z.string(), trashedPath: z.string().nullable() }),
      z.object({ ok: z.literal(false), message: z.string() }),
    ]),
  },
  /** Undo a delete: bring an item back from the Trash to where it was. */
  restoreEntry: {
    input: z.object({ rootId: z.string().min(1), relativePath: z.string().min(1), trashedPath: z.string().min(1) }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), message: z.string() }),
    ]),
  },
  /** Paste or duplicate: copy into a folder of the same tree under a free name. */
  copyEntry: {
    input: z.object({ rootId: z.string().min(1), relativePath: z.string().min(1), destinationDirectory: z.string().max(4096) }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), relativePath: z.string() }),
      z.object({ ok: z.literal(false), message: z.string() }),
    ]),
  },
  /** Move one file or folder into another folder of the same tree; never overwrites. */
  moveEntry: {
    input: z
      .object({
        rootId: z.string().min(1),
        relativePath: z.string(),
        destinationDirectory: z.string().max(4096),
      })
      .strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), relativePath: z.string() }),
      z.object({ ok: z.literal(false), message: z.string() }),
    ]),
  },
  /** Rename one file or folder. The tree root is refused. */
  renameEntry: {
    input: z
      .object({
        rootId: z.string().min(1),
        relativePath: z.string(),
        newName: z.string().trim().min(1).max(4096),
      })
      .strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), relativePath: z.string() }),
      z.object({ ok: z.literal(false), message: z.string() }),
    ]),
  },
  /**
   * Search the text inside the files under a pinned root, not their names.
   * The walk respects the same hidden/ignored folders as the tree, and the
   * result carries one row per matching line.
   */
  searchInFiles: {
    input: z
      .object({
        rootId: z.string().min(1),
        query: z.string().min(1).max(1024),
        matchCase: z.boolean(),
        wholeWord: z.boolean(),
        useRegex: z.boolean(),
        limit: z.number().int().min(1).max(1000),
        include: z.string(),
        /** Comma-separated globs the search skips. */
        exclude: z.string(),
      })
      .strict(),
    output: z.object({
      matches: z.array(fileSearchMatchSchema),
      /** True when the match budget stopped the run before the tree was exhausted. */
      truncated: z.boolean(),
      filesWithMatches: z.number().int().nonnegative(),
    }),
  },
  /**
   * Replace a text query inside specific files under a pinned root. Each file
   * is written with the hash it was read at, so a file that changed under the
   * run is reported as a failure rather than clobbered.
   */
  replaceInFiles: {
    input: z
      .object({
        rootId: z.string().min(1),
        query: z.string().min(1).max(1024),
        replacement: z.string().max(10000),
        matchCase: z.boolean(),
        wholeWord: z.boolean(),
        useRegex: z.boolean(),
        relativePaths: z.array(z.string()).min(1).max(500),
      })
      .strict(),
    output: z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        files: z.array(fileReplaceOutcomeSchema),
        failures: z.array(z.object({ relativePath: z.string(), message: z.string() })),
        totalReplaced: z.number().int().nonnegative(),
      }),
      z.object({ ok: z.literal(false), message: z.string() }),
    ]),
  },
});
