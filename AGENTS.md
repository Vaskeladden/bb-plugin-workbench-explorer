## Project Overview

**bb-plugin-workbench-explorer** (Workbench Explorer) is a [BB](https://getbb.app) plugin that keeps a file explorer open across threads. Choose a project source or thread workspace as its pinned folder. Switching threads leaves the folder, expanded directories, and selection in place. Built with TypeScript, React 19, and Tailwind CSS.

The rail carries two tabs — **Files** (name/path search) and **Search text** (content search with replace) — and integrates with chat by revealing paths written in messages, including bare filenames resolved via a name index over the search roots.

## Common Commands

```bash
npm install           # Install dependencies
bb plugin build       # Build the plugin
bb plugin reload workbench-explorer  # Reload plugin in development
bun test              # Run the unit tests
```

## Architecture

### Entry Points

- **`server.ts`** — Plugin server entry point. Registers RPC handlers via `rpcContract`. Manages settings, host connection for filesystem operations, search roots, and the ignored-dirs set. Content search is handed to the host; replace runs here through a per-call `hostFileStore` adapter over BB's host SDK (`bb.sdk.files.read`, `bb.sdk.files.write`).
- **`host.ts`** — Host entry point. Exposes `statPath`, `listDirectory`, `searchInFiles`, and `removePath` handlers that run in the host process for filesystem access. Delegates to `statHostPath`/`listHostDirectory`/`removeHostPath` in `src/host-listing.ts` and `searchHostInFiles` in `src/host-search.ts`.
- **`app.tsx`** — Frontend app. Registers UI slots:
  - `experimental_appOverlay` → `GlobalFileExplorerRail` (the persistent right rail)
  - `experimental_threadHeaderAction` → `FileExplorerHeaderAction` (toggle button + chat path bridge)
  - `sidebarFooterAction` → toggle rail open (icon: `FileText`)
  - `commandPaletteAction` ×2 → "File Explorer: find a file" (opens + focuses search) and "File Explorer: show pinned folder"
  - `composer.customize` for `NewThreadFileExplorerAction` (new-thread scope) and `ChatDraftBridge` (thread/queued-message/side-chat/new-thread scopes)

### Contracts

- **`shared.ts`** — SDK-free schemas, types, and constants shared between server and frontend. Browser-safe; imported by all frontend components, hooks, and lib modules. Exports `SKIP_FILE_NAMES` (a `Record<string, true>`), all Zod schemas (`treeEntrySchema`, `workspaceSchema`, `rootChoiceSchema`, `workspaceResultSchema`, `revealRootSchema`, `revealResultSchema`, `searchHitSchema`, `fileSearchMatchSchema`, `fileReplaceOutcomeSchema`, `anchorFixSchema`), and all their inferred TypeScript types.
- **`contract.ts`** — Server RPC contract. Imports schemas from `shared.ts` and uses `defineRpcContract` (server-only `@get-bb/plugin-sdk`) to wire the 19 RPC methods. Frontend code imports only types from here via `import type`.
- **`host-contract.ts`** — Host-side contract for `statPath`, `listDirectory`, `searchInFiles`, and `removePath` calls.

### Key Source Modules (`src/`)

- **`reveal.ts`** — Chat path and search resolution. The core reveal engine that resolves paths mentioned in chat via a widening search (exact → ancestor → name index), re-roots the tree, and produces search hits and anchor fixes. Exports `Resolved`, `resolveOne`, `resolveInWorkspace`, `resolveInRoot`, `resolvePaths`, `searchFiles`, `searchFilesInRoot`, `resolveFileAnchors`, `PathProbe`, `SearchRootsGetter`, `makeSearchRootsGetter`.
- **`name-index.ts`** — Name-based file indexing for bare filename resolution (e.g., `AGENTS-base.md` resolves without specifying a folder). Performs a bounded BFS walk of search roots with mtime-based caching. Exports `findByName` and `searchByQuery`.
- **`listing.ts`** — Server-side directory listing with a short-TTL cache (8s) and bounded size (500 entries). Exports `listDir` (delegates host calls via a callback) and `invalidateListings`.
- **`host-listing.ts`** — Host-side listing. `statHostPath` follows symlinks (rejects only lexical `..`/absolute escapes), `listHostDirectory` lists immediate children with skip patterns and git-ignore annotation.
- **`roots.ts`** — Root path resolution. Maps opaque server-minted root IDs to `{hostId, rootPath}` pairs. Bounded to 500 entries (oldest-first eviction). Never trusts client-supplied hostId/rootPath for destructive operations.
- **`workspace.ts`** — Workspace resolution for project sources vs. thread workspaces. Handles personal threads (uses configured `treeRoot` setting) vs. real projects (uses environment checkout path). Exports `workspaceForThread`, `workspaceForProject`, `listRootChoices`.
- **`search-in-files.ts`** — Content search walk and replace across files in a pinned root. The walk is the fallback engine (used when ripgrep cannot answer) and the home of the shared line shaping (`matchLine`). Walks directories via `HostSearchReader`, bounded by 4000 files, 24 depth, 1MB file size. Exports `searchInFiles`, `replaceInFiles`, `matchLine`, `HostSearchReader`, `HostFileStore`, `HostSearchFs`, `HostSearchEntry`, `HostSearchRead`, `HostSearchReadResult`, `MAX_FILES`, `MAX_DEPTH`, `MAX_FILE_BYTES`, `BINARY_EXTENSIONS`.
- **`host-search.ts`** — Host-side text search: runs ripgrep (npm `ripgrep`, WASM) at the pinned root, maps its JSON rows through `matchLine`, falls back to the walk over local `node:fs`. Exports `searchHostInFiles`.
- **`text-match.ts`** — Regex/text matching utilities for content search. Builds a single global `RegExp` per query (supporting case sensitivity, whole-word, regex). Exports `buildMatcher`, `findMatches`, `countMatches`, `replaceMatches`, `escapeRegExp`, `MatchOptions`.
- **`create-file.ts`** — Create an empty file from a user-typed name in a given folder. Validates name, checks for collisions, writes via `bb.sdk.files.write`. Returns workspace-relative path.
- **`create-folder.ts`** — Create a folder from a user-typed name. Validates, checks collisions, writes via `bb.sdk.files.mkdir`.
- **`rename-entry.ts`** — Rename a file or folder. Validates name, checks collisions, performs `bb.sdk.files.rename`. The tree root is refused.
- **`delete-entry.ts`** — Delete a file or folder. The tree root is refused. Folders are removed recursively.
- **`os-actions.ts`** — OS-level actions: `revealInExplorer` (cross-platform: `open -R` on macOS, `explorer /select` on Windows, `xdg-open` on Linux; WSL-aware) and `copyTextToClipboard` (multiple clipboard backends with fallback).
- **`ignore.ts`** — Skip patterns. Exports `shouldSkip` (checks `SKIP_FILE_NAMES` / ignored dirs against a `TreeEntry`) and `sortEntries` (directories first, then alphabetical).
- **`bb-git.ts`** — Branch changes from bb's Git plugin (`bb--git`): finds the ready environment holding a root (`environmentForRoot`), reads its merge base and ahead count (`status`), the changed files (`files`, `branch_committed`) and one file's patch (`patches`). `host-git-status.ts` keeps git only for a pull request's head on a base-branch checkout and for roots that are no bb environment.
- **`git-ignore.ts`** — Git ignore annotation. Uses `git check-ignore -z --stdin` to determine which files are ignored. Returns null set when git is unavailable.
- **`entry-name.ts`** — Validates user-typed filenames (bare name, no path separators, not `.`/`..`, not empty).
- **`paths.ts`** — Path safety utilities. `resolveUnderRoot` (lexical confinement, allows symlinked targets), `toRelativePath`, `assertSafeRelative`.
- **`pool.ts`** — Bounded concurrency helper (`mapLimit`) for parallel filesystem checks.

### Components (`components/`)

- **`GlobalFileExplorerRail.tsx`** — The right-side rail container. Mounted once per BB window (navigation never unmounts it). Manages two tabs (Files/Search text), pinned root selector, rail open/close, resize handle, and refresh button. Persists pinned root and active tab to localStorage.
- **`FileExplorerPanel.tsx`** — Tree view container. Combines `FileExplorerSearchBox`/`FileExplorerSearchResults` when searching, otherwise `FileExplorerBody`.
- **`FileExplorerSearch.tsx`** — Search box (debounced, 280ms, min 2 chars, limit 20) with inline results list. Results sorted with active workspace first. Selecting a result reveals it in the tree via the same path as chat anchors.
- **`FileContentSearchPanel.tsx`** — Content search panel with query input, replace input, match options (case/whole-word/regex toggles), and replace-all button. Groups matches by file with per-file replace action.
- **`FileExplorerBody.tsx`** — Tree body rendering. Recursive `TreeRow` component with context menu, git-ignore dimming, twistie expand/collapse, and root-level create/reload controls.
- **`FileExplorerHeaderAction.tsx`** — Thread header button bundle: `ChatPathBridge` + toggle rail button. Listens for rail open/close events.
- **`NewThreadFileExplorerAction.tsx`** — New thread composer button (icon: `FileText`). Also registers surface navigation for the null-thread route.
- **`RailResizeHandle.tsx`** — Drag-to-resize with pointer events. Keyboard accessible (ArrowLeft/ArrowRight, 16px steps). Double-click resets to 216px default.
- **`FileTypeIcon.tsx`** — Seti-style file type icons via SVG glyph + color from `lib/file-type.ts`.
- **`ChatPathBridge.tsx`** — Mounts in the thread header. Drives the chat path scanner (`mountChatPathButtons`) with RPC and thread context. Registers surface navigation.
- **`ChatDraftBridge.tsx`** — Mounts inside each composer. Registers a writable chat target so "Add to chat" context menu items can paste paths into drafts.
- **`ui/`** — shadcn/ui components (Button, Dialog, DropdownMenu, ContextMenu, Icon, etc.)

### Lib (`lib/`)

- **`rail-state.ts`** — Rail open/closed state. Uses localStorage + custom event (`RAIL_EVENT`) for cross-surface sync. `initializeRailOpen` reads stored value, `toggleRailOpen` flips without waiting for settings.
- **`rail-width.ts`** — Rail width sizing. Default 216px, range 160–720px. Clamped so chat retains at least 320px. Persisted via localStorage. Live drag updates without persisting.
- **`rail-inset.ts`** — Body padding reservation for the fixed rail overlay. Acquired by rail, released on cleanup.
- **`chat-draft-bus.ts`** — Bus for adding paths to open chat drafts. Stack-based (last registered composer wins). Scope keys derived from `PluginComposerScope` (thread, queued-message, side-chat, new-thread).
- **`chat-path-buttons.ts`** — DOM scanner that mounts "reveal in tree" buttons on chat path links. Caches verdicts per thread with TTL. Uses `createTimedCache` for path existence and anchor fixes.
- **`reveal-bus.ts`** — One-slot hand-off between chat content scripts and the mounted tree. Pending requests are delivered when the tree subscribes.
- **`search-focus-bus.ts`** — One-slot hand-off for command-palette "find a file" focus requests.
- **`surface-navigation.ts`** — Registers and resolves `useBbNavigate` per thread route. Keyed by threadId (or "new-thread").
- **`timed-cache.ts`** — Per-scope TTL cache for verdicts (default 10min for path cache). Used by `chat-path-buttons.ts`.
- **`file-type.ts`** — Seti-style file glyph and color detection. Maps file names and extensions to glyphs (markdown, json, git, config, react, shell, code, etc.).
- **`open-preview.ts`** — Opens files in BB's preview panel. Prefers workspace target for environment-rooted files; falls back to host-by-absolute-path for re-rooted or remote files.
- **`utils.ts`** — `cn` (clsx + tailwind-merge) and `formatHomePathForDisplay` (abbreviate home paths for display only).
- **`portal-scope.ts`** — Returns portal scope attributes for `data-bb-portaled-overlay` / `data-bb-plugin-root` / `data-bb-plugin`.
- **`visible-reveal.ts`** — Ensures a revealed child row appears in the tree even when the host directory listing omits dotfolders. Only for unverified reveal chains.

### Hooks (`hooks/`)

- **`useWorkspaceTree.ts`** — Tree state management: expansion, selection, loading/error states, re-rooting, visible reveal injection. Calls `listDir` RPC with caching. Subscribes to `reveal-bus` for chat-triggered reveals. The `reveal` callback returns `Revealed | null` (workspace, relativePath, isDirectory). Exposed: `confirmDelete`, `settingsLoading`, `active`, `isRerooted`, `dirs`, `expanded`, `selected`, `setSelected`, `reveal`, `toggleDir`, `showCreated`, `foregetPath`, `reload`.
- **`useFileSearch.ts`** — File name search. Debounced (280ms), min 2 chars, limit 20. Calls `searchFiles` RPC. Results sorted with active workspace first. Selecting a result reveals it in the tree.
- **`useSearchInFiles.ts`** — Content search. Debounced (320ms), min 2 chars, limit 500. Calls `searchInFiles` and `replaceInFiles` RPC. Groups matches by file. Options: matchCase, wholeWord, useRegex.
- **`useBrowserDimmingModal.ts`** — No-op stub (host app injects the real implementation at build time).

## Key Patterns

### BB Plugin SDK

- Uses `@get-bb/plugin-sdk` (version `0.5.29` in devDependencies, minimum `0.5.9` in engines).
- Plugin config: `bb plugin config file-explorer`
- Entry points: `server.ts` (server), `host.ts` (host), `app.tsx` (client).

### Path Aliases

```typescript
// @/* maps to project root
import { listDir } from "@/src/listing"
import { cn } from "@/lib/utils"
import { useWorkspaceTree } from "@/hooks/useWorkspaceTree"
import { Button } from "@/components/ui/button"
```

Configured in `tsconfig.json` (paths: `@/*` → `./*`) and `components.json` (aliases for `components`, `ui`, `lib`, `utils`, `hooks`).

### State Persistence

Three layers of persistence:


| What                                                                                        | Storage                       | Key                                   |
| ------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------- |
| Settings (openByDefault, confirmDelete, showSkipped, ignoredFolders, treeRoot, searchRoots) | `bb.settings.define`          | survives BB restarts                  |
| Rail open state                                                                             | `localStorage` + custom event | `bb-plugin-workbench-explorer:rail-open`   |
| Rail width                                                                                  | `localStorage` + custom event | `bb-plugin-workbench-explorer:rail-width`  |
| Pinned root ID                                                                              | `localStorage`                | `bb-plugin-workbench-explorer:pinned-root` |
| Active tab (files/search)                                                                   | `localStorage`                | `bb-plugin-workbench-explorer:tab`         |
| Tree expansion state                                                                        | In-memory (per window)        | not persisted                         |
| Path resolution cache                                                                       | In-memory `createTimedCache`  | scoped by threadId, 10min TTL         |


### Filesystem Access

- All filesystem operations go through the **host** via `host.call("statPath"/"listDirectory", ...)` or `bb.sdk.hosts.directory`/`bb.sdk.files.*`.
- Root IDs are server-minted (UUID via `randomUUID`) and map to `{hostId, rootPath}` pairs in a bounded registry (500 entries). Client-supplied rootId, never hostId/rootPath — security: a direct RPC caller cannot point destructive ops at any path.
- `onThisComputer()` checks if a root is on the primary host before performing OS-level actions (`revealInExplorer`, `copyTextToClipboard`).
- `resolveUnderRoot` in `src/paths.ts` provides lexical confinement (`..` rejected) but follows symlinks — a deliberate posture for browsing.
- `statHostPath` follows symlinks for reveal purposes; `listHostDirectory` follows symlinks in `readdir`/`stat` but skips broken links.

### Search & Reveal

The reveal engine in `src/reveal.ts` uses a widening search strategy (per `resolveOne`):

1. **Exact path** — as written, and with the workspace folder's own name stripped from the front
2. **Nearest ancestor** — `rules/*.mdc` resolves to the `rules/` folder
3. **Name index** — bare filenames (`AGENTS-base.md`) matched via the in-memory file index

When a path lands in another registered project, the tree **re-roots** there rather than reporting a miss. The `findOutsideWorkspace` function searches all candidate roots (projects + search roots + their immediate subdirectories).

- `resolvePaths` calls `searchFiles` (name search across roots) and `resolveFileAnchors` (chat link repair)
- `resolveInWorkspace` is thread-scoped; `resolveInRoot` is pinned-root-scoped
- `resolveFileAnchors` only fixes dead links — a working chat link is left alone
- Caching: roots cache (30s TTL), listing cache (8s TTL), path verdict cache (10min TTL)

### Content Search & Replace

- `searchInFiles` (RPC) resolves the pinned root and hands the search to the **host** (`host.call("searchInFiles")`), so the files never cross the host bridge and a root on another paired host searches there
- `src/host-search.ts` runs **ripgrep** (npm `ripgrep`, WASM, bundled into `host.js` — no binary on the host) rooted at the pinned root via a synthetic guest preopen (`GUEST_ROOT`, because a guest `.` resolves against the worker cwd, which is `/`), streaming `--json` rows and stopping collection at `limit`
- ripgrep is the candidate filter, the JavaScript matcher stays the authority: every line it reports goes through `matchLine` (in `search-in-files.ts`), so highlight, `lineMatches`, and replace agree
- The run is `--no-ignore --hidden`, plus globs for `ignoredFolders`, `SKIP_FILE_NAMES`, and `BINARY_EXTENSIONS`: a file the tree shows must be a file the search reads
- Fallback: a pattern the Rust engine refuses (lookaround, say) or a ripgrep run that exits 2 falls back to the walk in `search-in-files.ts` (`searchInFiles`, BFS bounded to 4000 files, 24 depth, 1MB per file) over a local `node:fs` reader
- Whole-word matching is applied by the JavaScript matcher only — ripgrep returns a superset of candidate lines
- `replaceInFiles` still runs on the server, reading and writing through `HostFileStore` (`bb.sdk.files`), and writes each file against the SHA256 it was read at — a changed file is refused, not clobbered
- One global `RegExp` per query (via `buildMatcher` in `text-match.ts`) ensures highlight and replace agree

### Skip Patterns

- `ignoredFolders` setting: its `default` (in `server.ts`) is empty — no folders are hidden until a user adds names. Server `getIgnoredDirs()` and client `useWorkspaceTree` derive the skipped set from this setting alone — no hardcoded constant in `contract.ts`. A user adds folder names (one per line) to hide them; clearing a line un-hides it.
- `SKIP_FILE_NAMES` = `new Set([".DS_Store"])` (file-level skips; not user-configurable)
- `shouldSkip` in `ignore.ts` checks these against a `TreeEntry` (directories checked against ignored dirs, files against `SKIP_FILE_NAMES`)
- Git-ignore: `git-ignore.ts` uses `git check-ignore -z --stdin` per directory; ignored entries flagged with `gitIgnored: true` on the `TreeEntry` schema
- Controlled by `showSkipped` setting in host listing and `ignoredFolders` setting on the client

## TypeScript Types

Key types defined in `contract.ts`:

```typescript
// A file or directory entry in the tree
interface TreeEntry {
  name: string              // entry name (basename)
  relativePath: string      // path relative to root
  kind: "file" | "directory"
  gitIgnored?: boolean      // true if git would not track it
}

// A workspace root the tree can browse
interface Workspace {
  environmentId: string | null   // null for re-rooted or personal roots
  hostId: string
  rootPath: string
  rootName: string               // basename of rootPath
  rootId: string                 // server-minted opaque ID
}

// A root offered in the folder selector
interface RootChoice {
  id: string                     // e.g. "source:abc123" or "thread:xyz789"
  label: string                  // "Project Name · /path/to/root"
  projectId: string | null
  workspace: Workspace
}

interface SearchHit {
  name: string                   // basename
  relativePath: string           // relative to root
  absolutePath: string           // for click-to-reveal
  rootName: string               // which root it lives in
}

// One matching line from content search
interface FileSearchMatch {
  relativePath: string
  name: string
  line: number                   // 1-based
  text: string                   // trimmed line (clipped for transport)
  column: number                 // 0-based offset of first match
  length: number                 // match length
  lineMatches: number            // total matches on this line
}

// One file's outcome from replace
interface FileReplaceOutcome {
  relativePath: string
  replaced: number               // count of replacements
}

// A chat link bb aimed at a file that doesn't exist, with the real target
interface AnchorFix {
  text: string                   // anchor text
  href: string                   // original href (workspace-relative)
  absolutePath: string           // verified absolute path
  hostId: string
  isDirectory: boolean
}

// Where a reveal landed outside the current workspace
interface RevealRoot {
  hostId: string
  rootPath: string
  rootName: string
  rootId: string
}

type PathProbe = (
  hostId: string, rootPath: string, relativePath: string,
) => Promise<{ isDirectory: boolean } | null>

type SearchRootsGetter = () => Promise<string[]>
```

### RPC Contract (19 methods)


| Method                | Direction     | Purpose                                                                |
| --------------------- | ------------- | ---------------------------------------------------------------------- |
| `listRootChoices`     | client→server | List pinned folder options (projects, thread workspace, personal root) |
| `resolveInRoot`       | client→server | Resolve a path against the pinned root                                 |
| `searchFilesInRoot`   | client→server | Name search scoped to pinned root                                      |
| `workspaceForThread`  | client→server | Resolve a thread's workspace root                                      |
| `workspaceForProject` | client→server | Resolve a project's source root                                        |
| `resolveInWorkspace`  | client→server | Resolve a path against a thread's workspace                            |
| `resolvePaths`        | client→server | Filter chat paths to those that exist                                  |
| `searchFiles`         | client→server | Name search across thread workspace + search roots                     |
| `resolveFileAnchors`  | client→server | Repair dead chat links pointing at wrong workspace                     |
| `clientLog`           | client→server | Forward browser diagnostics to bb.log                                  |
| `listDir`             | client→server | List directory with skip patterns + caching                            |
| `revealInExplorer`    | client→server | Open in system file manager (primary host only)                        |
| `copyTextToClipboard` | client→server | Copy text to system clipboard (primary host only)                      |
| `createFile`          | client→server | Create empty file, return relative path                                |
| `createFolder`        | client→server | Create folder, return relative path                                    |
| `deleteEntry`         | client→server | Delete file or folder (recursive)                                      |
| `renameEntry`         | client→server | Rename file or folder                                                  |
| `searchInFiles`       | client→server | Text search within files under a pinned root                           |
| `replaceInFiles`      | client→server | Text replace within files under a pinned root                          |


## Settings

Defined in `server.ts` via `bb.settings.define`:


| Setting          | Type               | Label                                         | Default         | Notes                                            |
| ---------------- | ------------------ | --------------------------------------------- | --------------- | ------------------------------------------------ |
| `openByDefault`  | boolean            | Show the pinned file explorer when BB opens   | `true`          | Controls rail visibility on startup              |
| `confirmDelete`  | boolean            | Confirm before deleting files and folders     | `true`          | Safety dialog for delete/rename                  |
| `showSkipped`    | boolean            | Show hidden files and folders                 | `false`         | Reveals `.git`, `node_modules`, etc.             |
| `ignoredFolders` | string (multiline) | Folders to hide by default                    | `""` (empty)    | Folder names hidden in tree and search; one name per line; leave empty to hide nothing |
| `treeRoot`       | string             | Root folder for personal threads              | `""`            | `~/Documents`-style path for BB personal threads |
| `searchRoots`    | string (multiline) | Folders to search for paths mentioned in chat | `"~/Documents"` | Each folder + immediate subdirs searchable       |


## Testing

Tests are `node:test` + `node:assert/strict` TypeScript files living alongside source in `*.test.ts`, excluded from `tsconfig.json` compilation. Run them with `bun test` (Bun resolves the extensionless relative imports; plain `node --test` does not).

|
 
T
e
s
t
 
f
i
l
e
 
|
 
C
o
v
e
r
a
g
e
 
|
||---|---|
| `src/listing.test.ts` | Directory listing with caching and invalidation |
| `src/name-index.test.ts` | Name-based file indexing (findByName, searchByQuery) |
| `src/reveal-host.test.ts` | Host-side reveal (resolveInRoot, resolveInWorkspace) |
| `src/independent-root.test.ts` | Root resolution across hosts and projects |
| `src/rename-entry.test.ts` | Rename with collision and root-protection checks |
| `src/delete-entry.test.ts` | Delete with recursive folder removal |
| `src/git-ignore.test.ts` | Git ignore pattern annotation |
| `src/bb-git.test.ts` | bb--git file paths re-based onto a root inside the repository |
| `src/host-git-status.test.ts` | Status, uncommitted diffs, and git branch changes against a named base |
|`src/search-in-files.test.ts`|Content search and replace with hash-conditional writes|
|`src/host-search.test.ts`|Host search via ripgrep: line/column mapping, options, ignored folders, binaries, limit, fallback|
| `src/text-match.test.ts` | Regex/text matching (literal, case, whole-word, regex) |
| `src/pool.test.ts` | Bounded concurrency mapLimit |
| `lib/rail-state.test.ts` | Rail open/closed state persistence |
| `lib/timed-cache.test.ts` | TTL cache behavior |
| `lib/surface-navigation.test.ts` | Surface navigation registration |
| `lib/chat-draft-bus.test.ts` | Chat target registration and path dispatch |
| `lib/chat-path-buttons.test.ts` | Chat path button DOM scanner and anchor resolution |
| `lib/file-type.test.ts` | File type icon detection |
| `lib/visible-reveal.test.ts` | Visible reveal child injection |
| `lib/find-in-folder.test.ts` | Find-in-folder scope handoff store (consume clears once) |
| `src/glob-match.test.ts` | Include/exclude glob matching: parse, compile, ancestors |

## Code Style

- TypeScript strict mode
- ESNext modules (`"type": "module"`)
- JSX via `react-jsx` transform
- Tailwind CSS with shadcn/ui design system
- Path alias `@/*` → project root
- Functions named descriptively (verb-first: `resolveInWorkspace`, `listHostDirectory`, `findByName`)
- Error handling: server-side returns tagged union `{ok: true, ...} | {ok: false, message: string}`
- Tests focus on behavior, boundaries, and invariants — not plumbing or field copies

