# Server Manager

The manager (`packages/loxel/src/server/<name>-lsp-manager.ts`) is a thin proxy over `StdioLspManager` in `stdio-lsp-manager.ts`; how the base works is in `packages/loxel/docs/LANGUAGE_SERVERS.md`. Extend `WorktreeLspManager`, which supplies one session per worktree, `createSession(ws, wtPath)` / `destroySession(ws)` for `server.ts`, `cwd` and the worktree as `rootUri` / `workspaceFolders`. Extend `StdioLspManager` directly only when the session holds more state (Python, ruff), and copy that plumbing from `WorktreeLspManager`.

## Hooks

| Hook                                       | Use it for                                                                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveBinary(context)`                   | Required. Usually `resolveBundledBinary(name, devPath?)` (execPath sibling, then `devPath` or `node_modules/.bin`, then PATH). May return a promise; frames are held until it resolves |
| `spawnArgs()`                              | Servers that don't take `["--stdio"]`                                                                                                                                                  |
| `disableSemanticTokens`                    | Buggy semantic tokens, or TextMate highlights the language better (Docker, Terraform, Astro, Tombi)                                                                                    |
| `requiresFullTextSync`                     | Servers that mishandle incremental `didChange` (Docker)                                                                                                                                |
| `suppressedFeatures`                       | Features Monaco must not get from this server, static or dynamically registered: formatting owned by format on save (ruff, Tombi)                                                      |
| `forwardWatchedFiles`                      | Servers that register file watchers to hear about unopened files and config (basedpyright, ruff, TypeScript, Tombi). Needs `getSessionWorkspace`, which `WorktreeLspManager` provides  |
| `getInitializationOptions(session)`        | Settings the server reads at startup (Astro's TypeScript SDK, Terraform's ignored dirs, ruff's `showSyntaxErrors`)                                                                     |
| `onClientInitialized(session)`             | Settings the server only takes by push, `workspace/didChangeConfiguration` after `initialized` (Docker, YAML and Tombi schemas)                                                        |
| `workspaceConfiguration(session, section)` | Settings the server pulls with `workspace/configuration` (basedpyright); see below                                                                                                     |
| `onSessionClosed(session)`                 | Releasing per-session resources (subscriptions, watchers); may run more than once                                                                                                      |
| `handleServerFrame` / `handleClientData`   | Rewriting messages; only TypeScript and Docker need it                                                                                                                                 |

## Settings a server pulls

monaco-lsp-client does not answer `workspace/configuration`, so the base does. Defining `workspaceConfiguration` advertises the capability in `initialize` and routes each requested section to it; return the section's value, or `null` for unset. When an answer would change, call `notifyConfigurationChanged(session)`: it sends `didChangeConfiguration` with `settings: null`, and the server pulls again. basedpyright answers `python.pythonPath` from the shared Python environment and re-announces after each re-resolution (`subscribePythonEnv`).

## A second server for a language

Python runs basedpyright and ruff on the same `python` models. Each server is a full server-side integration of its own; the language's Monaco registration, highlighting, icons and URI scheme already exist:

- Its own manager and client module, with the same language IDs. The client syncs every model of those languages to both servers.
- Diagnostics stay apart because each client's marker owner is its route (`python-lsp`, `ruff-lsp`); nothing to configure, as long as the route names differ.
- Decide which server owns each overlapping feature and turn it off in the other: `suppressedFeatures` for capabilities (ruff's formatting), the server's own settings for diagnostics (ruff's `showSyntaxErrors: false`, since basedpyright reports syntax errors). Leave features that don't compete (ruff's organize imports, which basedpyright lacks).

## Project-provided binaries

A server can run the project's own install so its pinned version and config apply (ruff from the worktree's Python environment). Make `resolveBinary` async and fall back to the bundled binary. Anything taken from the worktree or its environment must pass the environment trust rule in `python-env.ts` (`isEnvShippedByRepo` for an environment, `isShippedByRepo` for a single file; see "Environment trust rule" in LANGUAGE_SERVERS.md), since a binary the repository commits would run repository code. Re-pick when the environment changes (`subscribePythonEnv`), and when the pick differs, `detach` the session and close its socket with `LSP_RESTART_CLOSE_CODE`: the client reconnects and the new session spawns the new binary. Also pick again once the session is built, in case a re-resolution landed while it spawned (`spawnedRuff` in `ruff-lsp-manager.ts`), and probe a binary's version in the worktree, since version-manager shims pick by directory. Do not widen or bypass the trust rule.
