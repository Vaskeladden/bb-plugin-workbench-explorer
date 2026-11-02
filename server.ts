import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract } from "./contract";
import { hostContract } from "./host-contract";
import type { PathProbe } from "./src/reveal";
import { createFile } from "./src/create-file";
import { createFolder } from "./src/create-folder";
import { deleteEntry } from "./src/delete-entry";
import { renameEntry } from "./src/rename-entry";
import { moveEntry } from "./src/move-entry";
import { copyTextToClipboard, revealInExplorer } from "./src/os-actions";
import { resolveRoot } from "./src/roots";
import { registerMaterialIconRoute } from "./src/material-icons-route";
import { invalidateListings, listDir } from "./src/listing";
import {
  makeSearchRootsGetter,
  resolveInRoot,
  resolveFileAnchors,
  resolveInWorkspace,
  resolvePaths,
  searchFiles,
  searchFilesInRoot,
} from "./src/reveal";
import { listRootChoices, workspaceForProject, workspaceForThread } from "./src/workspace";
import {
  replaceInFiles,
  type HostFileStore,
} from "./src/search-in-files";

export { rpcContract } from "./contract";

const THREAD_PR_TTL_MS = 30_000;
const threadPullRequests = new Map<string, { at: number; value: { repo: string; number: number } | null }>();

/**
 * The pull request jb-flow links to a thread (open or draft first, else the
 * latest), so a thread working from the default-branch checkout still shows
 * its PR's files. Null without jb-flow. Cached briefly: status polls often.
 */
async function threadPullRequest(bb: BbPluginApi, threadId: string): Promise<{ repo: string; number: number } | null> {
  const cached = threadPullRequests.get(threadId);
  if (cached !== undefined && Date.now() - cached.at < THREAD_PR_TTL_MS) return cached.value;
  let value: { repo: string; number: number } | null = null;
  try {
    const state = await bb.sdk.plugins.callRpc({
      pluginId: "jb-flow",
      method: "state_get",
      input: null,
      outputSchema: z.object({
        threadPrs: z.record(z.string(), z.array(z.object({ repo: z.string(), number: z.number(), state: z.string() }).passthrough())),
      }).passthrough(),
    });
    const prs = state.threadPrs[threadId] ?? [];
    const pick = prs.find((pr) => pr.state === "open" || pr.state === "draft") ?? prs[prs.length - 1];
    value = pick ? { repo: pick.repo, number: pick.number } : null;
  } catch {
    value = null;
  }
  threadPullRequests.set(threadId, { at: Date.now(), value });
  return value;
}

export default async function plugin(bb: BbPluginApi): Promise<void> {
  bb.log.info("loaded");
  registerMaterialIconRoute(bb);
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const probe: PathProbe = (hostId, rootPath, relativePath) =>
    host.call("statPath", { rootPath, relativePath }, { hostId });
  const onThisComputer = async (rootId: string): Promise<boolean> => {
    const root = resolveRoot(rootId);
    if (root === undefined) throw new Error("File Explorer root expired. Choose the folder again.");
    const config = await bb.sdk.system.config();
    return root.hostId === config.primaryHostId;
  };

  /**
   * The host slice a replace reads and writes through. Built per call so the
   * `hostId` and `rootPath` a root resolved to are what the host confines every
   * read and write to. Search does not come through here: ripgrep runs on the
   * host, inside the root, and only rows travel back.
   */
  const hostFileStore = (hostId: string, rootPath: string): HostFileStore => ({
    read: async (absolutePath) => {
      const result = await bb.sdk.files.read({ hostId, path: absolutePath, rootPath });
      return {
        content: result.content,
        contentEncoding: result.contentEncoding,
        sha256: result.sha256,
        sizeBytes: result.sizeBytes,
      };
    },
    write: async ({ absolutePath, content, expectedSha256 }) => {
      const result = await bb.sdk.files.write({
        hostId,
        path: absolutePath,
        rootPath,
        content,
        contentEncoding: "utf8",
        expectedSha256,
      });
      return result.outcome === "written";
    },
  });

  const settings = bb.settings.define({
    openByDefault: {
      type: "boolean",
      label: "Show the pinned file explorer when BB opens",
      default: true,
    },
    confirmDelete: {
      type: "boolean",
      label: "Confirm before deleting files and folders",
      default: true,
    },
    showSkipped: {
      type: "boolean",
      label: "Show hidden files and folders",
    },
    ignoredFolders: {
      type: "string",
      label: "Folders to hide by default (one per line)",
      description:
        "Folder names hidden in the tree and search. Empty by default — " +
        "add folder names (one per line) to hide them.",
      default: "",
      experimental_multiline: true,
    },
    treeRoot: {
      type: "string",
      label: "Root folder for personal threads",
      description:
        "Absolute path or ~/ path used only for BB personal threads. Project threads always show their project workspace.",
      default: "",
    },
    searchRoots: {
      type: "string",
      label: "Folders to search for paths mentioned in chat (one per line)",
      description:
        "Each folder and its immediate subfolders can host a revealed path, so an unregistered folder like ~/Documents/Agent-Harness still resolves.",
      default: "~/Documents",
    },
  });

  const getSearchRoots = makeSearchRootsGetter(async () => {
    const values = await settings.get();
    return typeof values.searchRoots === "string" ? values.searchRoots : undefined;
  });

  const getTreeRoot = async (): Promise<string | undefined> => {
    const values = await settings.get();
    const root = typeof values.treeRoot === "string" ? values.treeRoot.trim() : "";
    return root === "" ? undefined : root;
  };

  const getIgnoredDirs = async (): Promise<Set<string>> => {
    const values = await settings.get();
    const raw = typeof values.ignoredFolders === "string" ? values.ignoredFolders : "";
    return new Set(raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  };
  bb.rpc.register(rpcContract, {
    listRootChoices: async (input) => ({
      choices: await listRootChoices(bb, input, await getTreeRoot()),
    }),
    resolveInRoot: async (input) =>
      resolveInRoot(bb, input, getSearchRoots, probe, await getIgnoredDirs()),
    searchFilesInRoot: async (input) =>
      searchFilesInRoot(bb, input, await getIgnoredDirs()),
    workspaceForThread: async ({ threadId }) =>
      workspaceForThread(bb, threadId, await getTreeRoot()),
    workspaceForProject: async ({ projectId }) =>
      workspaceForProject(bb, projectId, await getTreeRoot()),
    resolveInWorkspace: async (input) => {
      const ignoredDirs = await getIgnoredDirs();
      const result = await resolveInWorkspace(bb, input, getSearchRoots, probe, ignoredDirs);
      bb.log.info(
        `reveal ${JSON.stringify(input.path)} -> ${
          result.ok ? `${result.relativePath} (root ${result.root?.rootName ?? "thread"})` : result.message
        }`,
      );
      return result;
    },
    clientLog: ({ message }) => {
      bb.log.info(`client: ${message}`);
      return { ok: true };
    },
    resolvePaths: async (input) => {
      const ignoredDirs = await getIgnoredDirs();
      const result = await resolvePaths(bb, input, getSearchRoots, probe, ignoredDirs);
      bb.log.info(
        `resolvePaths: ${input.paths.length} candidates -> ${result.known.length} known`,
      );
      return result;
    },
    searchFiles: async (input) => {
      const ignoredDirs = await getIgnoredDirs();
      const result = await searchFiles(bb, input, getSearchRoots, ignoredDirs);
      bb.log.info(
        `searchFiles ${JSON.stringify(input.query)} -> ${result.hits.length} hits`,
      );
      return result;
    },
    resolveFileAnchors: async (input) => {
      const ignoredDirs = await getIgnoredDirs();
      const result = await resolveFileAnchors(bb, input, getSearchRoots, probe, ignoredDirs);
      for (const fix of result.fixes) {
        bb.log.info(`anchor fix ${JSON.stringify(fix.text)}: ${fix.href} -> ${fix.absolutePath}`);
      }
      return result;
    },
    listDir: (input) => listDir(input, ({ hostId, ...request }) =>
      host.call("listDirectory", request, { hostId })),
    revealInExplorer: async (input) => {
      if (!await onThisComputer(input.rootId)) return { ok: false, message: "This file is on another computer." };
      return revealInExplorer(input);
    },
    copyTextToClipboard: async (input) => {
      if (!await onThisComputer(input.rootId)) return { ok: false, message: "This file is on another computer." };
      return copyTextToClipboard(input.text);
    },
    createFile: async (input) => {
      const result = await createFile(bb, host, input);
      if (result.ok) invalidateListings(input.rootId);
      return result;
    },
    createFolder: async (input) => {
      const result = await createFolder(bb, host, input);
      if (result.ok) invalidateListings(input.rootId);
      return result;
    },
    deleteEntry: async (input) => {
      const result = await deleteEntry(bb, host, input);
      if (result.ok) invalidateListings(input.rootId);
      return result;
    },
    restoreEntry: async ({ rootId, relativePath, trashedPath }) => {
      const root = resolveRoot(rootId);
      if (root === undefined) return { ok: false as const, message: "This file explorer panel is out of date — reopen it and try again." };
      try {
        const result = await host.call("restorePath", { rootPath: root.rootPath, relativePath, trashedPath }, { hostId: root.hostId });
        if (!result.ok) return { ok: false as const, message: result.message ?? "Could not restore the item." };
      } catch (cause) {
        return { ok: false as const, message: cause instanceof Error ? cause.message : "Could not restore the item." };
      }
      invalidateListings(rootId);
      return { ok: true as const };
    },
    copyEntry: async ({ rootId, relativePath, destinationDirectory }) => {
      const root = resolveRoot(rootId);
      if (root === undefined) return { ok: false as const, message: "This file explorer panel is out of date — reopen it and try again." };
      try {
        const result = await host.call("copyPath", { rootPath: root.rootPath, relativePath, destinationDirectory }, { hostId: root.hostId });
        if (!result.ok || result.relativePath === null) return { ok: false as const, message: result.message ?? "Could not copy the item." };
        invalidateListings(rootId);
        return { ok: true as const, relativePath: result.relativePath };
      } catch (cause) {
        return { ok: false as const, message: cause instanceof Error ? cause.message : "Could not copy the item." };
      }
    },
    moveEntry: async (input) => {
      const result = await moveEntry(bb, host, input);
      if (result.ok) invalidateListings(input.rootId);
      return result;
    },
    renameEntry: async (input) => {
      const result = await renameEntry(bb, host, input);
      if (result.ok) invalidateListings(input.rootId);
      return result;
    },
    quickOpen: async ({ rootId, query, limit }) => {
      // Ask for more than shown: ignored hits are dropped after ranking.
      const { hits } = await searchFilesInRoot(bb, { rootId, query, limit: Math.min(limit * 4, 200) }, await getIgnoredDirs());
      const root = resolveRoot(rootId);
      if (root === undefined || hits.length === 0) return { hits: hits.slice(0, limit) };
      const { ignored } = await host.call(
        "ignoredPaths",
        { rootPath: root.rootPath, relativePaths: hits.map((hit) => hit.relativePath) },
        { hostId: root.hostId },
      ).catch(() => ({ ignored: [] as string[] }));
      const skip = new Set(ignored);
      return { hits: hits.filter((hit) => !skip.has(hit.relativePath)).slice(0, limit) };
    },
    gitStatus: async ({ rootId, threadId }) => {
      const root = resolveRoot(rootId);
      if (root === undefined) return { isRepository: false, entries: [], truncated: false };
      const pullRequest = threadId ? await threadPullRequest(bb, threadId) : null;
      return host.call("gitStatus", { rootPath: root.rootPath, ...(pullRequest ? { pullRequest } : {}) }, { hostId: root.hostId });
    },
    gitAction: async ({ rootId, action, relativePaths }) => {
      const root = resolveRoot(rootId);
      if (root === undefined) return { ok: false, message: "This explorer is out of date. Reopen it and try again." };
      return host.call("gitAction", { rootPath: root.rootPath, action, relativePaths }, { hostId: root.hostId });
    },
    gitDiff: async ({ rootId, relativePath, against, pullRequest }) => {
      const root = resolveRoot(rootId);
      if (root === undefined) {
        return { ok: false as const, message: "This diff is out of date. Open it again from the Changes tab." };
      }
      const { patch } = await host.call("gitDiff", { rootPath: root.rootPath, relativePath, ...(against ? { against } : {}), ...(pullRequest ? { pullRequest } : {}) }, { hostId: root.hostId });
      return { ok: true as const, patch };
    },
    searchInFiles: async (input) => {
      const root = resolveRoot(input.rootId);
      if (root === undefined) {
        throw new Error("This file explorer panel is out of date — reopen it and try again.");
      }
      const result = await host.call("searchInFiles", {
        rootPath: root.rootPath,
        query: input.query,
        matchCase: input.matchCase,
        wholeWord: input.wholeWord,
        useRegex: input.useRegex,
        limit: input.limit,
        ignoredFolders: [...await getIgnoredDirs()],
        include: input.include,
        exclude: input.exclude,
      }, { hostId: root.hostId });
      bb.log.info(
        `searchInFiles ${JSON.stringify(input.query)} -> ${result.matches.length} matches in ${result.filesWithMatches} files`,
      );
      return result;
    },
    replaceInFiles: async (input) => {
      const root = resolveRoot(input.rootId);
      if (root === undefined) {
        return { ok: false as const, message: "This file explorer panel is out of date — reopen it and try again." };
      }
      const result = await replaceInFiles(
        hostFileStore(root.hostId, root.rootPath),
        root.rootPath,
        input,
      );
      if (result.ok) {
        invalidateListings(input.rootId);
        bb.log.info(
          `replaceInFiles ${JSON.stringify(input.query)} -> ${result.totalReplaced} replacements in ${result.files.length} files`,
        );
      }
      return result;
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
