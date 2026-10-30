# TypeScript

The TypeScript manager, the one server that is not a thin proxy, and the two diagnostic paths. Shared language-server architecture: [LANGUAGE_SERVERS.md](../LANGUAGE_SERVERS.md).

## Manager

| Manager                                                 | Binary                                                                           | Args           | Scope    | Flags and config                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------- | -------- | -------------------------------------------------------------------------------------- |
| [ts-lsp-manager.ts](../../src/server/ts-lsp-manager.ts) | TypeScript 7 `tsc` via [typescript-path.ts](../../src/server/typescript-path.ts) | `--lsp -stdio` | worktree | Overrides `handleClientData` / `handleServerFrame` entirely (see below); watched files |

The TypeScript manager is the outlier. It always overwrites `rootUri` / `workspaceFolders` / `initializationOptions` (it does not use the base merge), passing its preferences as `initializationOptions.userPreferences`, which TypeScript reads as its `js/ts` settings section when the client does not advertise `workspace/configuration`; it answers `workspace/configuration` (the same `js/ts` section) and `window/workDoneProgress/create` itself because TypeScript blocks on them, rewrites `languageId` to `typescriptreact` / `javascriptreact` for `.tsx` / `.jsx`, drops `textDocument/*` messages whose URI does not have a TS/JS/JSON extension, and translates URIs (see [URI schemes](../LANGUAGE_SERVERS.md#uri-schemes)). It deliberately forwards `client/registerCapability` so Monaco sees TypeScript's dynamic semantic-tokens registration; the base has already taken TypeScript's file-watcher registrations out by then (see watched files above).

TypeScript indents the code of quick fixes and completions with one set of format settings for the whole server (4 spaces by default), so the manager makes them follow each file's indentation. The TS client sends a `loxel/documentIndentation` notification (`DOCUMENT_INDENTATION_METHOD` in [lsp-indentation-model.ts](../../src/api/lsp-indentation-model.ts)) for each live model with its options (`insertSpaces`, `tabSize`, `indentSize`, the indentation `resolveIndentation` gave it, see [EDITOR.md](../EDITOR.md#indentation)) when it connects and whenever they change. The manager consumes it and keeps the indentation per file until `didClose`. Before forwarding `textDocument/codeAction`, `textDocument/completion` or `completionItem/resolve` (whose data names the file), it sends `workspace/didChangeConfiguration` with the `js/ts` section and that file's `format` settings if they differ from the last ones sent (sizes capped at 16 columns). A fix that also edits another file indents that file's code the same way, since TypeScript has one setting per request. TypeScript applies a configuration change before it takes the next request's snapshot, and the change only builds a new snapshot (no program rebuild). Formatting requests need none of this: Monaco sends the model's `indentSize` as their `tabSize`.

## Diagnostics

There are two TypeScript diagnostic paths:

- **Live, per file.** The TS LSP publishes diagnostics, which `monaco-lsp-client` turns into markers under the client's owner.
- **Project-wide snapshot.** `GET /api/diagnostics?wt=&ref=&worktree=` ([routes.ts](../../src/server/routes.ts) `handleDiagnostics`) calls `getDiagnostics` in [diagnostics.ts](../../src/server/diagnostics.ts), which runs `tsc --noEmit --pretty false` (30 s timeout) and parses lines into `TypeScriptDiagnostic` from [diagnostics-model.ts](../../src/api/diagnostics-model.ts) (repo-relative file, 1-based line and column, code, severity, `node_modules` excluded). The code editor and the diff view apply these as `typescript` markers, and only request the snapshot for files `hasTypeScriptDiagnostics` in [typescript-files.ts](../../src/lib/typescript-files.ts) accepts: TS/JS sources (`TS_SOURCE_EXTENSIONS`, which the TS manager's routing also extends) and `tsconfig*.json`, where `tsc` reports config errors.

The server skips `tsc` and returns no diagnostics when the worktree, or the `ref`'s tree, has no root `tsconfig.json`. For the working tree (no `ref`) `tsc` runs directly in the worktree and nothing is cached on the server. For a `ref` the server validates it against `REF_PATTERN`, deduplicates concurrent requests, checks the tree for `tsconfig.json` with `git ls-tree` (caching an empty result when it is missing), creates a detached temporary worktree named `${INTERNAL_WORKTREE_PREFIX}diag-<sha8>` in a `mktemp -d` directory, symlinks `node_modules` from the source checkout, runs `tsc`, caches the result by ref in memory for the server's lifetime, and force-removes the worktree. `INTERNAL_WORKTREE_PREFIX` ([worktree-utils.ts](../../src/server/worktree-utils.ts)) hides these worktrees from worktree lists, and `pruneOrphanedTempWorktrees` in `server.ts` force-removes all of them when a project is initialized, to clean up after crashes.

On the client the snapshot is a TanStack query under `queryKeys.diagnostics(...)`.

## Where to look

- Diagnostics: [diagnostics.ts](../../src/server/diagnostics.ts), [worktree-utils.ts](../../src/server/worktree-utils.ts).
