# Editing stack

How file-backed panels load, edit, save and reconcile files with disk, and how the file operations, drafts, Others files, localdb and search features around them are built.

## Panels and identity

A file opens in one of four center panel types, chosen by extension in `filePanelType()` ([open-file.ts](../src/lib/open-file.ts)): `.md` opens the markdown editor, `.excalidraw` the drawing editor, media extensions ([media-extensions.ts](../src/lib/media-extensions.ts)) the media viewer, and everything else the code editor. `dispatchOpenFile()` turns that into a `loxel-open-*` event, and `openFileBacked()` ([panel-creators.ts](../src/lib/panel-creators.ts)) creates or focuses the panel.

The absolute file path is the identity of an open file everywhere: the panel id (`${idPrefix}${filePath}`, so a center layout holds at most one panel per path and type), the key in the editor state store, the key of every content cache, and the React Query `fileContent` key. Relative paths only appear in legacy routes and in search/Quick Open payloads relative to the worktree.

Where to look:

- [open-file.ts](../src/lib/open-file.ts), [open-path.ts](../src/lib/open-path.ts): routing a path to a panel, folder or worktree.
- [panel-creators.ts](../src/lib/panel-creators.ts): `openFileBacked`, `handleFileMoved`, `handleFileDeleted`, and the "new note/drawing/code file" creators that create drafts.

## Disk-synced content

Every file-backed editor (code, markdown, drawing) is built on [use-disk-synced-content.ts](../src/hooks/use-disk-synced-content.ts). The editor supplies `deserialize`, an optional module-level content cache, optional merge callbacks, and populates `getSerializedContentRef` with a function returning its current serialized text. The hook owns the rest:

- **Loading.** A React Query fetch of `GET /api/file-content?path=<abs>&wt=<panel worktree>` with `refetchOnMount: "always"`, so a remounted editor picks up changes made while its worktree was unsubscribed.
- **Autosave.** `handleChange()` marks the file dirty and arms two timers: a 250 ms idle debounce (`AUTOSAVE_DEBOUNCE_MS`) and a 5 s cap (`AUTOSAVE_MAX_WAIT_MS`) so continuous typing still saves. `saveNow()` (explicit save) clears both. A pending autosave is flushed on unmount and when the panel's `filePath` changes.
- **Format on save.** Editors set `saveOptionsRef` (explicit saves) and `autoSaveOptionsRef` (autosaves, only when `formatOnAutoSave` is on) from the formatting settings. The server formats only files in the worktree's own tree; Others folders, drafts and external files are written as-is. Formatter detection and backends are covered in [LANGUAGE_SERVERS.md](LANGUAGE_SERVERS.md).
- **Programmatic guard.** `isProgrammaticRef` is set by the editor around imperative content updates so its change listener does not report them as user edits.

### Editor file state

[editor-state.ts](../src/store/editor-state.ts) is a Zustand store with one `EditorFileEntry` per open path (`openFile` is idempotent; `closeFile` drops the entry):

| Field                                     | Purpose                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| `state`                                   | `clean`, `dirty`, `saving` or `diverged`                                          |
| `pendingNonces`                           | nonces of in-flight saves; several can overlap while the user keeps typing        |
| `savedSnapshots`                          | editor content captured per nonce at save start, the merge base for format echoes |
| `baseContent`                             | content at the last clean point, the merge base for external changes              |
| `diskContent`                             | latest external disk content while `diverged`                                     |
| `getEditorContent` / `applyMergedContent` | callbacks registered by text editors for auto-merge; null for the drawing editor  |

`handleDiskChange(path, nonces, content)` is the core transition:

- **Own echo** (a nonce matches): if other saves are still pending the echo is _superseded_ and only its nonces are dropped. Otherwise, if disk differs from the editor (server-side formatting), the formatted text is merged into the editor with `preferOurs` and the per-nonce snapshot as base, so formatting applies only where the user has not typed since; then the file becomes clean once no nonces remain.
- **External change while `dirty`/`saving`:** a line-based 3-way merge (`tryAutoMerge`) of `baseContent`, the editor content and disk. Success applies the result to the editor and advances `baseContent`; a conflict, or an editor that cannot apply it, moves the file to `diverged`.
- **`diverged`:** later changes only refresh `diskContent`. [ConflictBanner.tsx](../src/components/editor/ConflictBanner.tsx) offers `acceptDiskVersion` (editor reloads disk) or `keepMyChanges` (back to dirty with `baseContent` advanced to disk, autosave re-armed).
- **`clean`:** the store does nothing; the editor's own disk-content effect replaces its content (see each editor below). These effects read the state live from the store rather than from render-time values, because a keystroke between commit and effect can flip it to dirty.

[three-way-merge.ts](../src/lib/three-way-merge.ts) diffs base→ours and base→theirs with `diffArrays` and fails on overlapping, non-identical hunks unless `preferOurs` is set, in which case the conflicting "theirs" hunks are dropped.

### Save path and write nonces

1. `saveEditorContent()` ([save-editor-content.ts](../src/lib/save-editor-content.ts)) creates a `crypto.randomUUID()` nonce, calls `markSaving` (which snapshots the editor) and posts `POST /api/file-write { path, content, nonce, worktreePath, format? }`.
2. `handleFileWrite` ([routes.ts](../src/server/routes.ts)) resolves the absolute path with `resolveFilePath` ([server.ts](../src/server/server.ts)): drafts first, then the worktree tree, then Others folders, then individually opened external files. It formats if requested and writes through the owning service's `writeWithNonce`.
3. [file-sync-service.ts](../src/server/file-sync-service.ts) records the nonce for the key (expiring after 5 s), and its next debounced flush reports the change with every nonce pending for that key. The owning service broadcasts `file_content_changed { path, nonces }` to the worktree's subscribers.
4. [ws-bridge.ts](../src/queries/ws-bridge.ts) invalidates the diff view's working-tree content, and for an open file either refreshes the query (clean) or calls `handleDiskChange`.

The HTTP response is not the completion signal: the `saving → clean` transition is driven by the echo. The response's (possibly formatted) content is stashed by nonce for 2 s so the echo handler can use it instead of refetching (`consumeSavedContent`). If no echo arrives within 10 s the nonce is dropped and the file returns to dirty. Pending saves are counted per worktree, and [useWsSubscription.ts](../src/hooks/useWsSubscription.ts) defers unsubscribing a worktree until `onWorktreeSavesDrained` fires so echoes are not lost on a worktree switch. Because all windows share one server and one nonce store, the saving window sees its own echo while other windows see an external change; see [SHARED_SERVER.md](SHARED_SERVER.md) and, for the watchers that produce events, [WATCHERS.md](WATCHERS.md).

A `worktree_files_resynced` message (after a watcher pause/resume) invalidates clean editors' queries and pushes fresh content for every non-clean editor through `handleDiskChange` with no nonces.

## Code editor (Monaco)

[CodeEditorPanel.tsx](../src/components/code-editor/CodeEditorPanel.tsx) creates one Monaco editor per panel on mount and reuses or creates the model for the file's URI:

- `file://<abs path>` for languages whose language server needs real disk paths (`yaml`, `json`, `dockerfile`, `dockerbake`, `terraform`, `astro`, `xml`).
- `loxel://HEAD/<abs path>` for everything else. These are the live, editable models; the diff view's read-only models use `loxel://<ref>/<path>#<side>` ([diff/EditorPanel.tsx](../src/components/diff/EditorPanel.tsx), see [DIFF_VIEW_SPEC.md](DIFF_VIEW_SPEC.md)).

The model is disposed with the panel, so undo history does not outlive the tab. Go-to-definition targets with the `loxel` scheme are routed to `dispatchOpenFile` by `registerEditorOpener` in [monaco-env.ts](../src/lib/monaco-env.ts); the editor sets every `gotoLocation` mode to `"goto"` because Monaco's peek widget resolves models through a path that ignores the opener. The same file lazily connects expensive language servers by counting live models (`file://` and `loxel://HEAD` only); LSP wiring is in [LANGUAGE_SERVERS.md](LANGUAGE_SERVERS.md).

Content flow: user edits call `handleChange(model.getValue())`. Clean-state disk updates use `model.setValue()` under `isProgrammaticRef`. Merges and "accept disk" use [compute-line-edits.ts](../src/lib/compute-line-edits.ts), which turns a line diff into minimal `ISingleEditOperation`s applied with `pushEditOperations`, so Monaco maps the caret through the change instead of resetting it.

Other per-panel behavior: language from `resolveLanguage(path, fileAssociations, content)` mapped by `toMonacoLanguage`; indentation from settings with `detectIndentation` off; `$schema` detection for JSON feeding [json-schema-registry.ts](../src/lib/json-schema-registry.ts); strict-JSON markers ([json-strict-validator.ts](../src/lib/json-strict-validator.ts)) for files resolved as `json` rather than `jsonc`; project TypeScript diagnostics applied as markers; and a TextMate scope inspector ([TextMateScopeInspector.ts](../src/components/code-editor/TextMateScopeInspector.ts)).

Themes: [monaco-theme.ts](../src/lib/monaco-theme.ts) registers a fallback `loxel-dark` theme synchronously and replaces it with the Shiki-converted [loxel-themes.ts](../src/lib/loxel-themes.ts) theme once the highlighter loads, reading editor chrome colors from CSS variables and layering semantic-token rules. [useThemeSync.ts](../src/hooks/useThemeSync.ts) toggles the `dark` class on `<html>`.

[useFileTabRename.ts](../src/hooks/useFileTabRename.ts) gives a file tab a rename handler only for files in the active worktree, its drafts, or its Others folders, and delegates to `renameFile()` (see File operations).

## Markdown editor (Milkdown)

[MarkdownEditor.tsx](../src/components/editor/MarkdownEditor.tsx) uses Milkdown's Crepe, a ProseMirror editor whose markdown parser and serializer are remark. The image-block and LaTeX features are disabled, code blocks are CodeMirror, and remark-stringify is configured with `-` bullets and rules to match oxfmt/Prettier. The editor holds a document tree, not text, which drives most of the design below.

### Frontmatter

[frontmatter.ts](../src/lib/frontmatter.ts) splits a leading `---` block positionally (no YAML validation). The body goes to Crepe; the YAML goes to [FrontmatterEditor.tsx](../src/components/editor/FrontmatterEditor.tsx), a Monaco editor on the model `file:///__frontmatter__/<path>.yaml`. `mergeFrontmatter` always writes exactly one blank line after the closing `---` when the body is non-empty, so a file with no blank line there gains one on its first save.

### Byte-identical untouched blocks

Serialization is canonical (`*` bullets become `-`, setext headings become ATX, blank-line runs collapse), so a naive save would rewrite every block of the file on any edit and produce noisy diffs. [markdown-source-preservation.ts](../src/lib/markdown-source-preservation.ts) prevents that:

- On load, `createSourceBaseline` records the source text, its top-level block ranges (from remark positions), and the canonical form of each block. Preservation is disabled for a source whose canonical form splits into a different number of blocks.
- On save, `preserveSource` splits the canonical output into blocks and aligns them with the baseline's canonical blocks by LCS (`alignBlocks`). Unchanged blocks are emitted as their original source bytes; changed or new blocks use serializer output. Separators (blank lines, link reference definitions) between blocks that were adjacent in the source are kept verbatim, including around a block edited in place.
- Blocks are matched by serialized form, not node identity, because Milkdown plugins rewrite attributes after load and programmatic replaces create new node objects.
- The result is validated: `canonicalize(output)` must equal the canonical output, otherwise the canonical output is used. Preservation can therefore only be skipped, never change the document.
- Already-canonical sources (anything the editor or a formatter wrote) short-circuit, and results are memoized per baseline.

The editor-side glue is `serializeBody` (use it instead of `crepe.getMarkdown()`), `setSourceBaseline` (called on load and after every programmatic apply), and `toEditorBody`, which converts raw disk bytes to the form the editor would serialize them in, so disk content can be compared with or used as a merge base against the live document. Trailing newlines are collapsed to one (`normalizeTrailingNewline`) because Milkdown's trailing plugin adds an empty paragraph.

### Applying disk content without moving the caret

`applyBodyToEditor` compares serialized markdown first (parse(serialize(doc)) is not structurally identical to the live doc), then dispatches `createMinimalReplaceTransaction` ([prosemirror-replace.ts](../src/lib/prosemirror-replace.ts)): it replaces only the span between `findDiffStart` and `findDiffEnd`, so ProseMirror maps the selection through the step. It carries the live doc's trailing empty paragraph into the target so the common suffix is found, and falls back to a whole-document replace with the caret clamped to its old offset when the sliced replace does not reproduce the target exactly. The transaction has `addToHistory: false`.

Echo suppression differs from the code editor because Milkdown's `markdownUpdated` listener is debounced and ignores `addToHistory: false` transactions:

- After a programmatic replace a stepless, listener-visible transaction is dispatched so the listener's previous-doc snapshot resyncs; otherwise a later user edit that restores that snapshot would never be reported.
- `lastAppliedBodyRef` holds the body last applied; a listener callback whose live body equals it is ignored as the programmatic echo, and anything else is a user edit.
- In the clean-state disk effect, live edits the debounced listener has not reported yet are 3-way merged onto the disk change (base: `lastSyncedDiskBodyRef`, the editor form of the previous disk content; `preferOurs`), and autosave is armed if the result differs from disk.

"Accept disk version" destroys and recreates Crepe (`crepeKey`). Module-level `editorContentCache` and `editorSelectionCache` keep content and caret across remounts (tab and layout swaps) and are migrated by `renameEditorCacheKey` on moves.

Search navigation uses `rawLineToProsePosition` ([prosemirror-position.ts](../src/lib/prosemirror-position.ts)): it parses the raw file with the editor's remark configuration, finds the text leaf at the target line and column, and walks ProseMirror text nodes in the same order (ordinal matching handles repeated text and nodes with no ProseMirror counterpart). Relative links in the document are opened with `openPath()` instead of navigating.

Tables are Crepe's GFM table feature (prosemirror-tables) with no custom node; Loxel only restyles them in [milkdown-theme.css](../src/styles/milkdown-theme.css).

### Directives and the localdb widget

[localdb-directive/remark-plugin.ts](../src/components/editor/localdb-directive/remark-plugin.ts) installs directive syntax restricted to what the editor understands:

- Only flow directives are parsed; text directives (`:name`) are never recognized, so prose like `10:30am` stays text.
- `:::localdb` containers become `localdb-block` nodes carrying their verbatim inner source and whether the fence was closed.
- Every other directive is unwrapped into paragraphs of verbatim inline `html` reproducing its source, so nothing is lost and Milkdown never sees an unknown node type.
- On serialize a line-initial `::` in prose is escaped, so typed text cannot become a directive on reload.

[schema.ts](../src/components/editor/localdb-directive/schema.ts) defines the atom node with attrs `table`, `view`, `viewId`, plus `extra` (unknown body lines kept verbatim) and `closed`. It serializes the block as one verbatim `html` node and widens the fence beyond any colon run in the body. [view.ts](../src/components/editor/localdb-directive/view.ts) renders `LocalDbWidget` in a React root inside a NodeView; widget configuration changes are `setNodeMarkup` transactions and so are saved through the normal markdown path. Round-trip behavior is pinned by `round-trip.test.ts` and `remark-plugin.test.ts`.

## Other content panels

- **Drawings** ([ExcalidrawEditor.tsx](../src/components/excalidraw-editor/ExcalidrawEditor.tsx)) use the same hook with JSON (de)serialization and `drawingContentCache`, but register no merge callbacks, so any external change while dirty goes straight to `diverged`. Clean-state updates compare scene versions before calling `updateScene`. Excalidraw fires empty `onChange`s during teardown, so layout code wraps `api.clear()` in `withDrawingCachePreserved`.
- **Media** ([MediaViewerPanel.tsx](../src/components/media-viewer/MediaViewerPanel.tsx)) has no editor state. It renders `/api/media-frame` in a sandboxed iframe whose CSP blocks network access for inlined SVGs, loads other media from `/api/file-raw`, and reloads on `file_content_changed` for its path.
- **Browser** panels ([BrowserPanel.tsx](../src/components/browser/BrowserPanel.tsx)) host an Electron `<webview>`; see [ELECTRON.md](ELECTRON.md#browser-panels).

## LocalDb

Each project has one SQLite database from [`@bizimind/localdb-sdk`](../../localdb-sdk/README.md), opened at project initialization at `<stateDir>/localdb/<hash12(project cwd)>/localdb.db`. Requests under `/api/localdb` are project-scoped and dispatched by [localdb-routes.ts](../src/server/localdb-routes.ts), which validates payloads with the SDK's zod parsers. Mutations broadcast `localdb_changed { scope, tableName?, tableId? }` to the project; [ws-bridge.ts](../src/queries/ws-bridge.ts) invalidates `["localdb", projectPath, ...]` queries and emits `loxel-localdb-changed`.

The UI is [LocalDbPanel.tsx](../src/components/localdb/LocalDbPanel.tsx) (a singleton center panel) and the shared components in [components/localdb/ui](../src/components/localdb/ui), which talk to the server through `makeRestAdapter("/api/localdb", projectPath)`. The markdown widget uses the same adapter. A `:::localdb` block stores only which table and view to show; the data lives in the project database, not in the markdown file.

## File operations

Server side, every file tree has a `FileOperationsService` ([file-operations-service.ts](../src/server/file-operations-service.ts)): the worktree's own (`git mv`/`git rm` for tracked paths, plain filesystem calls otherwise) and one per Others folder (`git: false`, so nothing is staged in an enclosing repo). Operations are serialized through a promise queue, validate paths and names, and resolve name collisions (`file 2.ts`, `file (copy).ts`). Each service keeps undo/redo stacks capped at 50 entries and 50 MB; deletes keep file contents and modes in memory so they can be restored. `FileOperationsHistory` orders undo across a worktree's services so undo targets the latest operation wherever it happened; it lives on the server per worktree, so windows on the same worktree share it. Undo and redo return a `FileOperationResult` ([file-operations-model.ts](../src/api/file-operations-model.ts)).

Client side:

- [useFileOperations.ts](../src/hooks/useFileOperations.ts): inline rename, delete confirmation, new file/folder, undo/redo (one request at a time).
- [useFileClipboard.ts](../src/hooks/useFileClipboard.ts) and [useProjectFileDrag.ts](../src/hooks/useProjectFileDrag.ts): cut/copy/paste and drag and drop (MIME types `application/x-project-file` and `application/x-detached-file`). Moves and copies stay within one tree; drafts can only go into the worktree.
- [rename-file.ts](../src/lib/rename-file.ts): the shared rename used by the tree and tabs.
- [project-file-helpers.ts](../src/lib/project-file-helpers.ts): `isWithin`, `findTreeRoot`, `fileParentDir` and related path helpers.

After any move, rename or delete the client remaps per-worktree UI paths (`renameProjectPaths`), dispatches `loxel-file-moved` or `loxel-file-deleted`, and invalidates parent directory queries. `handleFileMoved` closes the old editor-state entry, migrates content caches, and opens the new panel in the old tab's position before closing the old one; `handleFileDeleted` closes panels for the path and everything under it. Draft operations go through the drafts routes and are not in the undo history. Tree UI behavior is in [PROJECT_EXPLORER.md](PROJECT_EXPLORER.md) and [FILES_TREE.md](FILES_TREE.md).

## Drafts

Drafts (detached files) are files outside the repository, one flat directory per project and worktree: `<stateDir>/detached/<hash12(projectPath)>/<hash12(worktreePath)>/` (`getDetachedDir` in [config.ts](../src/server/config.ts)). [detached-files-service.ts](../src/server/detached-files-service.ts) watches it non-recursively, ignores dotfiles, and keeps a cached listing.

- Names are `<prefix> <n>[.<ext>]` with the lowest unused `n`. Creation uses the `wx` flag and retries on `EEXIST`, so concurrent creates from several windows cannot collide. The panel creators use `Note` + `md`, `Drawing` + `excalidraw`, and `Untitled` for code files.
- Listing changes broadcast `detached_files_changed`; content changes of existing files go through the shared `file_content_changed` broadcast with nonces, so drafts save exactly like worktree files.
- `moveToProject` refuses to overwrite and falls back to copy + delete across filesystems (`EXDEV`); `copyToProject` uses `COPYFILE_EXCL`. After a move the client dispatches `loxel-file-moved`, so an open draft tab becomes a worktree tab. The Drafts section UI is in [PROJECT_EXPLORER.md](PROJECT_EXPLORER.md).

[detached-path.ts](../src/lib/detached-path.ts) only holds display-name and directory-normalization helpers.

## External files and Others folders

Files and folders outside every project appear in the active worktree's Others section. Opening from Finder or the `loxel` CLI posts to `POST /api/open`, which sends `open_file` or `open_folder` to the window in use; `openFile`/`openFolder` ([open-path.ts](../src/lib/open-path.ts)) open the path in its owning worktree (switching if needed) or in the active worktree's Others section. See [ELECTRON.md](ELECTRON.md) and [TERMINALS.md](TERMINALS.md).

- **Others folders.** [external-folders-service.ts](../src/server/external-folders-service.ts) has two layers. `ExternalFolderRegistry` is server-wide: one `ProjectFilesService` with Git status disabled per folder, shared by every worktree listing it, broadcasting its changes to all of them. `ExternalFoldersService` is per worktree: the list of open folders, persisted in the store database under `external-folders:<wtPath>`, never nested (adding a parent replaces open children), each with its own `FileOperationsService` on the worktree's undo history. Watcher details are in [WATCHERS.md](WATCHERS.md).
- **Individual files.** [external-files-service.ts](../src/server/external-files-service.ts) keeps an in-memory set of individually opened files with one `fs.watch` each. It is not persisted. Instead, `resolveFilePathWithHint` in [routes.ts](../src/server/routes.ts) registers an unknown absolute path as an external file whenever the request carries a worktree hint, and the client re-sends `register_external_files` for open out-of-worktree editors on reconnect and when an Others folder that contains them is removed. Closing such a tab sends `close_external_file`. Files inside an open Others folder are served by the folder, not this service.

## Search

**Find in Files.** [SearchModal.tsx](../src/components/search/SearchModal.tsx) debounces queries by 300 ms and aborts the previous request. `GET /api/search` runs ripgrep (`rg --json`, fixed strings unless regex, `--max-count 50` per file, `--max-columns 500`, `maxResults` defaulting to 500 and capped at 2000), streams and parses the JSON lines, converts byte offsets to character offsets, and kills `rg` once the limit is hit. Scopes ([search-scope-model.ts](../src/components/search/search-scope-model.ts)) map to request params: presets (`all` searches the worktree and its drafts, `worktree`, `drafts`, `ignored` adds `--no-ignore`), worktree-relative paths for packages and custom folders, and `--glob` for extensions. Others folders are not searched. `GET /api/search-scopes` lists workspace packages, directories and extensions. [search.ts](../src/store/search.ts) persists only `recentCustomPaths`, through server storage. Response types are in [search-model.ts](../src/api/search-model.ts).

**Quick Open.** [FileSearchModal.tsx](../src/components/file-search/FileSearchModal.tsx) loads `GET /api/file-index` (`rg --files --hidden`, `.git` excluded, capped at 100,000 paths, worktree only) and refetches in the background on each open. [file-search.ts](../src/store/file-search.ts) caches the index and a 15-entry MRU per worktree. Ranking is `fuzzyMatchPath` in [fuzzy-match.ts](../src/lib/fuzzy-match.ts): score tiers from exact filename down to a fuzzy subsequence spread across the path, with a tiebreaker on path length and match spread. A `path:line[:col]` suffix is parsed by `parseQueryLocation`.

Both open results through `dispatchOpenFile` with a line and column; the markdown editor maps them with `rawLineToProsePosition`.

## Invariants

- One open file is one absolute path: one panel per path and type in a layout, one editor-state entry, one cache key. Paths from the server and the client must be normalized the same way (`resolve`, `canonicalPath`).
- Editor writes go only through `saveEditorContent`, which always sends a fresh nonce (`/api/file-write` requires one). A write without a nonce is seen as an external change by every editor, including the one that made it.
- Completion of a save is the nonce echo, not the HTTP response. Do not mark files clean elsewhere.
- Imperative editor updates must be invisible to the change listener (`isProgrammaticRef`, or `lastAppliedBodyRef` in markdown) or they trigger save, echo, apply loops.
- Merged or disk content is applied as minimal edits (`computeLineEdits`, `createMinimalReplaceTransaction`), never as a whole-content reset with a restored offset.
- Markdown round trip: blocks the user did not edit are written back byte-for-byte, and preservation is validated so it can only fall back to canonical output. Edited blocks take canonical form, trailing newlines collapse to one, and the frontmatter separator is normalized to one blank line.

When touching save or sync paths, run the package tests (`pnpm -C packages/loxel run test`) and check these suites in particular: [editor-state.test.ts](../src/store/editor-state.test.ts) (state machine, superseded echoes, typing during an echo), [three-way-merge.test.ts](../src/lib/three-way-merge.test.ts), [markdown-source-preservation.test.ts](../src/lib/markdown-source-preservation.test.ts), [MarkdownEditor.dom.test.ts](../src/components/editor/MarkdownEditor.dom.test.ts) (listener resync, `toEditorBody`, `applyBodyToEditor`), [prosemirror-replace.test.ts](../src/lib/prosemirror-replace.test.ts), [prosemirror-position.test.ts](../src/lib/prosemirror-position.test.ts), the localdb directive tests, [file-sync-service.test.ts](../src/server/file-sync-service.test.ts), and the route tests for drafts and Others folders ([routes.detached.test.ts](../src/server/routes.detached.test.ts), [routes.external-folders.test.ts](../src/server/routes.external-folders.test.ts)).
