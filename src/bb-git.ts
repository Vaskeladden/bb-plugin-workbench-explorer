import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { GitStatusEntry, LineCounts } from "../lib/git-status";

/**
 * What a branch changed since it left its base comes from bb's own Git plugin
 * (`bb--git`), the one BB's «Workspace changes» panel reads, so the explorer
 * and that panel compare against the same merge base and list the same files.
 */
const GIT_PLUGIN = "bb--git";

const failureSchema = z.object({ outcome: z.enum(["not_applicable", "unavailable", "failed"]) });

const statusRowSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("available"),
    workspace: z.object({
      branch: z.object({ currentBranch: z.string().nullable() }),
      mergeBase: z.object({ mergeBaseBranch: z.string(), aheadCount: z.number() }).nullable(),
    }),
  }),
  failureSchema.extend({ outcome: z.literal("not_applicable") }),
  failureSchema.extend({ outcome: z.literal("unavailable") }),
  failureSchema.extend({ outcome: z.literal("failed") }),
]);

const fileSchema = z.object({
  path: z.string(),
  changeKind: z.enum(["added", "modified", "deleted", "renamed", "copied", "type_changed"]),
  revision: z.string(),
  /** Line counts as bb's panel shows them; zero on both sides for a binary file. */
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  binary: z.boolean().optional(),
});
export type BbGitFile = z.infer<typeof fileSchema>;

const patchSchema = z.object({ path: z.string(), patch: z.string(), truncated: z.boolean() });

const filesSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), files: z.array(fileSchema), initialPatches: z.array(patchSchema) }),
  failureSchema.extend({ outcome: z.literal("not_applicable") }),
  failureSchema.extend({ outcome: z.literal("unavailable") }),
]);

const patchRowSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), patch: patchSchema }),
  failureSchema.extend({ outcome: z.literal("not_applicable") }),
  failureSchema.extend({ outcome: z.literal("unavailable") }),
]);

export interface BbGitBranch {
  /** The branch bb compares the environment with: its merge base branch, else its default. */
  base: string;
  /** Commits on HEAD that the base does not have. */
  commits: number;
  /** The checkout sits on the base branch itself, so it has no branch of its own to compare. */
  onBase: boolean;
}

const ENVIRONMENT_TTL_MS = 30_000;
const environmentCache = new Map<string, { at: number; value: string | null }>();

/**
 * The ready git environment whose checkout holds `rootPath` on that host —
 * the deepest one, so a worktree inside a checkout wins over the checkout.
 * Null for a folder that is no bb environment (a personal Documents root, a
 * project source with no checkout environment).
 */
export async function environmentForRoot(bb: BbPluginApi, hostId: string, rootPath: string): Promise<string | null> {
  const key = `${hostId} ${rootPath}`;
  const cached = environmentCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < ENVIRONMENT_TTL_MS) return cached.value;
  const environments = await bb.sdk.environments.list({ hostId, status: "ready" });
  let best: { id: string; length: number } | null = null;
  for (const environment of environments) {
    if (!environment.isGitRepo || environment.path === null || environment.path === "") continue;
    const inside = path.relative(environment.path, rootPath);
    if (inside.startsWith("..") || path.isAbsolute(inside)) continue;
    if (best === null || environment.path.length > best.length) best = { id: environment.id, length: environment.path.length };
  }
  const value = best?.id ?? null;
  environmentCache.set(key, { at: Date.now(), value });
  return value;
}

/** The environment's comparison as `bb--git` resolves it; null when it has none (no merge base, not git, not ready). */
export async function bbGitBranch(bb: BbPluginApi, environmentId: string): Promise<BbGitBranch | null> {
  const rows = await bb.sdk.plugins.callRpc({
    pluginId: GIT_PLUGIN,
    method: "status",
    input: { keys: [environmentId] },
    outputSchema: z.record(z.string(), statusRowSchema),
  });
  const row = rows[environmentId];
  if (row?.outcome !== "available" || row.workspace.mergeBase === null) return null;
  const { mergeBaseBranch, aheadCount } = row.workspace.mergeBase;
  return { base: mergeBaseBranch, commits: aheadCount, onBase: row.workspace.branch.currentBranch === mergeBaseBranch };
}

function branchTarget(base: string) {
  return { type: "branch_committed" as const, mergeBaseBranch: base };
}

type FilesTarget = ReturnType<typeof branchTarget> | { type: "uncommitted" };

async function listFiles(bb: BbPluginApi, environmentId: string, target: FilesTarget) {
  const result = await bb.sdk.plugins.callRpc({
    pluginId: GIT_PLUGIN,
    method: "files",
    input: { environmentId, target, ignoreWhitespace: false },
    outputSchema: filesSchema,
  });
  return result.outcome === "available" ? result : null;
}

function branchFiles(bb: BbPluginApi, environmentId: string, base: string) {
  return listFiles(bb, environmentId, branchTarget(base));
}

const STATUS_BY_KIND: Record<BbGitFile["changeKind"], GitStatusEntry["status"]> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  copied: "renamed",
  type_changed: "modified",
};

/**
 * `bb--git` paths are relative to the repository's top level; `prefix` (from
 * `git rev-parse --show-prefix`) re-bases them onto the explorer root, a
 * folder inside a monorepo, and drops what lies outside it.
 */
export function branchEntries(files: readonly BbGitFile[], prefix: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const relative = file.path.slice(prefix.length);
    if (relative !== "") entries.push({ path: relative, status: STATUS_BY_KIND[file.changeKind], ...lineCounts(file) });
  }
  return entries;
}

/** A binary file's zeros are no count; a file without counts keeps none. */
function lineCounts(file: BbGitFile): LineCounts {
  if (file.binary === true) return { binary: true };
  if (file.additions === undefined || file.deletions === undefined) return {};
  return { additions: file.additions, deletions: file.deletions, binary: false };
}

/**
 * Each uncommitted file's line counts against HEAD, as bb's panel counts them
 * (an untracked file's lines all count as added), keyed by its path under the
 * root. Status, staging and conflicts stay git status's business. Null when
 * bb--git cannot list them.
 */
export async function bbGitUncommittedCounts(
  bb: BbPluginApi,
  environmentId: string,
  prefix: string,
): Promise<Map<string, LineCounts> | null> {
  const listing = await listFiles(bb, environmentId, { type: "uncommitted" });
  if (listing === null) return null;
  return new Map(branchEntries(listing.files, prefix).map(({ path, status: _status, ...counts }) => [path, counts]));
}

/** Files the branch's commits changed, as `bb--git` lists them, under `prefix`. Null when it cannot list them. */
export async function bbGitBranchEntries(
  bb: BbPluginApi,
  environmentId: string,
  base: string,
  prefix: string,
): Promise<GitStatusEntry[] | null> {
  const listing = await branchFiles(bb, environmentId, base);
  return listing === null ? null : branchEntries(listing.files, prefix);
}

/** A diff past this size is not worth drawing in a panel. */
const MAX_PATCH_BYTES = 2 * 1024 * 1024;

/**
 * One file's patch from the branch's commits, read the way bb's own diff view
 * reads it: the files listing gives its revision, and the keyed `patches`
 * read (or the listing's inline patch, for a small file) gives the patch.
 * `repoPath` is relative to the repository's top level.
 */
export async function bbGitBranchPatch(
  bb: BbPluginApi,
  environmentId: string,
  base: string,
  repoPath: string,
): Promise<string | null> {
  const listing = await branchFiles(bb, environmentId, base);
  const file = listing?.files.find((candidate) => candidate.path === repoPath);
  if (listing === null || file === undefined) return null;
  let patch = listing.initialPatches.find((candidate) => candidate.path === repoPath) ?? null;
  if (patch === null) {
    const key = JSON.stringify([environmentId, branchTarget(base), false, file.path, file.revision]);
    const rows = await bb.sdk.plugins.callRpc({
      pluginId: GIT_PLUGIN,
      method: "patches",
      input: { keys: [key] },
      outputSchema: z.record(z.string(), patchRowSchema),
    });
    const row = rows[key];
    patch = row?.outcome === "available" ? row.patch : null;
  }
  if (patch === null || patch.truncated || patch.patch.trim() === "" || patch.patch.length > MAX_PATCH_BYTES) return null;
  return patch.patch;
}
