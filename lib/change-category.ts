import type { GitStatusEntry } from "./git-status";

/**
 * What kind of file a change touches, for the Changes tab's totals and the
 * summary published to other plugins. Test outranks configuration, which
 * outranks docs, so `tests/fixtures/x.json` is a test and `.github/README.md`
 * is configuration.
 */
export type ChangeCategory = "code" | "conf" | "test" | "docs";

export const CHANGE_CATEGORIES: readonly ChangeCategory[] = ["code", "conf", "test", "docs"];

export const CATEGORY_LABEL: Record<ChangeCategory, string> = {
  code: "Kode",
  conf: "Conf",
  test: "Test",
  docs: "Docs",
};

const TEST_DIRECTORIES = new Set(["tests", "test", "__tests__", "e2e"]);
const CONF_EXTENSIONS = new Set(["json", "jsonc", "toml", "yaml", "yml", "ini", "cfg", "env", "lock", "lockb"]);
const CONF_NAMES = new Set(["makefile", "package-lock.json", "pnpm-lock.yaml", "uv.lock", "yarn.lock"]);
const CONF_DIRECTORIES = new Set([".github", ".codex"]);
const DOC_EXTENSIONS = new Set(["md", "mdx", "rst"]);
const DOC_DIRECTORIES = new Set(["docs", "doc"]);

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function isTest(directories: readonly string[], name: string): boolean {
  if (directories.some((directory) => TEST_DIRECTORIES.has(directory.toLowerCase()))) return true;
  return name === "conftest.py"
    || /^test_.+\.py$/u.test(name)
    || /.+_test\.(?:py|go)$/u.test(name)
    || /.+\.(?:test|spec)\.[^.]+$/u.test(name);
}

function isConf(directories: readonly string[], name: string): boolean {
  const lower = name.toLowerCase();
  if (directories.some((directory) => CONF_DIRECTORIES.has(directory))) return true;
  if (directories.at(-1) === ".claude" && /^settings.*\.json$/u.test(lower)) return true;
  if (CONF_NAMES.has(lower) || lower.startsWith("dockerfile")) return true;
  // Dotfiles: .env, .env.local, .mcp.json, .gitignore, .npmrc, .prettierrc.
  if (name.startsWith(".") || /\.env(?:\.|$)/u.test(lower)) return true;
  if (/^requirements.*\.txt$/u.test(lower)) return true;
  if (/\.config\.(?:js|ts|mjs|cjs|mts|cts)$/u.test(lower)) return true;
  return CONF_EXTENSIONS.has(extension(name));
}

function isDocs(directories: readonly string[], name: string): boolean {
  const ext = extension(name);
  if (DOC_EXTENSIONS.has(ext)) return true;
  return ext === "txt" && directories.some((directory) => DOC_DIRECTORIES.has(directory.toLowerCase()));
}

/** The category of a path relative to the explorer root (or the repository). */
export function changeCategory(path: string): ChangeCategory {
  const segments = path.split("/").filter((segment) => segment !== "");
  const name = segments.pop() ?? "";
  if (isTest(segments, name)) return "test";
  if (isConf(segments, name)) return "conf";
  if (isDocs(segments, name)) return "docs";
  return "code";
}

export interface CategoryTotals {
  files: number;
  additions: number;
  deletions: number;
  /** Binary files: changed, but without lines to count. */
  binary: number;
  /** Text files whose line counts are not known. */
  uncounted: number;
}

function emptyTotals(): Record<ChangeCategory, CategoryTotals> {
  const totals = {} as Record<ChangeCategory, CategoryTotals>;
  for (const category of CHANGE_CATEGORIES) totals[category] = { files: 0, additions: 0, deletions: 0, binary: 0, uncounted: 0 };
  return totals;
}

/**
 * Added and deleted lines per category over one list of changes. Each entry
 * counts once: a partly staged file is one entry, counted against HEAD.
 */
export function lineTotals(entries: readonly GitStatusEntry[]): Record<ChangeCategory, CategoryTotals> {
  const totals = emptyTotals();
  for (const entry of entries) {
    const bucket = totals[changeCategory(entry.path)];
    bucket.files += 1;
    if (entry.binary === true) bucket.binary += 1;
    else if (entry.additions === undefined || entry.deletions === undefined) bucket.uncounted += 1;
    else {
      bucket.additions += entry.additions;
      bucket.deletions += entry.deletions;
    }
  }
  return totals;
}

export type PublishedCategoryLines = Record<ChangeCategory, { files: number; additions: number; deletions: number }>;

/**
 * The per-category totals other plugins read: null when any text file in the
 * list has no line count, so a total is never smaller than the truth.
 */
export function publishedLines(entries: readonly GitStatusEntry[]): PublishedCategoryLines | null {
  const totals = lineTotals(entries);
  const lines = {} as PublishedCategoryLines;
  for (const category of CHANGE_CATEGORIES) {
    const { files, additions, deletions, uncounted } = totals[category];
    if (uncounted > 0) return null;
    lines[category] = { files, additions, deletions };
  }
  return lines;
}
