import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./host-contract";
import { listHostDirectory, removeHostPath, statHostPath } from "./src/host-listing";
import { searchHostInFiles } from "./src/host-search";
import { hostGitAction, hostGitDiff, hostGitStatus } from "./src/host-git-status";
import { copyHostPath, restoreHostPath, trashHostPath } from "./src/host-trash";
import { assertSafeRelative } from "./src/paths";
import { ignoredChildNames } from "./src/git-ignore";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    statPath: ({ rootPath, relativePath }) => statHostPath(rootPath, relativePath),
    listDirectory: ({ rootPath, relativePath, showSkipped, ignoredFolders }) =>
      listHostDirectory(rootPath, relativePath, showSkipped, ignoredFolders),
    searchInFiles: ({ rootPath, ignoredFolders, ...input }) =>
      searchHostInFiles(rootPath, input, new Set(ignoredFolders)),
    removePath: ({ rootPath, relativePath }) => removeHostPath(rootPath, relativePath),
    gitStatus: ({ rootPath, pullRequest }) => hostGitStatus(rootPath, pullRequest ?? null),
    ignoredPaths: async ({ rootPath, relativePaths }) => ({
      ignored: [...await ignoredChildNames(rootPath, relativePaths)],
    }),
    trashPath: ({ rootPath, relativePath }) => trashHostPath(rootPath, relativePath),
    restorePath: ({ rootPath, relativePath, trashedPath }) => restoreHostPath(rootPath, relativePath, trashedPath),
    copyPath: ({ rootPath, relativePath, destinationDirectory }) =>
      copyHostPath(rootPath, relativePath, destinationDirectory),
    gitAction: ({ rootPath, action, relativePaths }) => {
      for (const path of relativePaths) assertSafeRelative(path);
      return hostGitAction(rootPath, action, relativePaths);
    },
    gitDiff: async ({ rootPath, relativePath, against, pullRequest }) => {
      // `--no-index` would diff any file on the machine, so the path must stay
      // inside the root.
      assertSafeRelative(relativePath);
      if (relativePath.startsWith("/") || relativePath.startsWith("\\") || /^[A-Za-z]:/u.test(relativePath)) {
        throw new Error("path escapes the workspace");
      }
      return { patch: await hostGitDiff(rootPath, relativePath, against ?? "head", pullRequest ?? null) };
    },
  },
});
