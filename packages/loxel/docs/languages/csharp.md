# C#

C# files are served by the user's own csharp-ls, behind a gate on repository trust and the restored state. Shared language-server architecture: [LANGUAGE_SERVERS.md](../LANGUAGE_SERVERS.md). What the environment module offers (finding `dotnet`, `global.json`, projects, the restored state) is in [csharp-env.ts](../../src/server/csharp-env.ts).

## Manager

| Manager                                                         | Binary      | Args                                               | Scope    | Flags and config                                                                                                                |
| --------------------------------------------------------------- | ----------- | -------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [csharp-lsp-manager.ts](../../src/server/csharp-lsp-manager.ts) | `csharp-ls` | `--loglevel information`, `--solution` when one is | worktree | no process until the gate opens; watched files; pulled settings (`csharp` section); code lenses dropped; `repoTrustRestriction` |

Nothing is bundled, so there is no manifest under `scripts/language-servers/` and no third-party notice.

## The gate

`gate` decides whether a process runs, in this order, stopping at the first answer: not trusted (nothing else runs, neither git nor `dotnet`), no project (quiet), no usable toolchain (a notice), nothing restored among what would load (a notice). A project with a layout `csharp-env.ts` cannot read counts as restored, since csharp-ls never restores anything itself and trust covers loading it.

### Connections with no process

`startSession` is overridden so a connection starts out held. A held connection has no process: it answers `initialize` with no capabilities and `shutdown`, refuses other requests, and sends the gate's notice as one `window/showMessage` warning. The client therefore stays connected with no features rather than stopped, which is what a closed gate means: a normal state, not a failed server. `serverFailureReason` would stop the client until a restart and read as an error.

Frames that arrive before the first decision are kept. If the first decision opens the gate, the base's `startSession` runs and they replay to the real server. Once a hold has answered `initialize`, opening the gate closes the socket with `LSP_RESTART_CLOSE_CODE`, and the reconnect goes through the gate again. Only one decision runs at a time per connection, with a deadline so a stalled git or `dotnet` cannot leave `initialize` unanswered; checks that could not finish keep the last notice and try again on the timer.

What makes a held connection decide again: `onRepoTrustChange` (a change restarts it, since `repoTrusted` is fixed for a connection), `subscribeCSharpRestore`, `notifyWatchedFilesChanged` for project, solution, `global.json` and tool manifest files, `onLoginShellEnvChange`, and, only while a toolchain notice is up, a timer, since nothing announces an install. The login-shell environment is captured again at the start of that wait and on every sixth tick.

### Running sessions

csharp-ls reads a project's references when it loads and does not read `project.assets.json` again, reported or not. So a rewritten assets file (`watchedIgnoredGlobs`) or a change in which projects are restored (`subscribeCSharpRestore`, which also covers layouts outside `obj`) restarts the session once writes have settled, and the reconnect goes through the gate, which may hold it. These restarts stop at a cap per worktree, for a build target that rewrites its assets file while loading. The base restarts a session when trust changes.

## Finding csharp-ls

`pickCSharpLs` returns a command or a notice. A csharp-ls in the worktree's tool manifest outranks a global one and runs as `dotnet tool run csharp-ls --` from the worktree root: a repository that pins it chose a version matching its SDK, and the gate has already established trust. There is no fallback from it to a global tool, so what a repository asks for is what it gets or what the notice talks about.

Otherwise `resolveGlobalDotnetTool` looks on the `PATH` without the worktree's directories, then in `~/.dotnet/tools`, which is not always on the login-shell `PATH`; anything inside the worktree or tracked by git does not count. The version is read from the home directory, cached per binary, and compared with `MIN_CSHARP_LS_VERSION`, the first release with `csharp.analyzersEnabled`.

The notices lead with the step that works, because `dotnet tool install` under an SDK older than 10, including an older one `global.json` selects, fails with an error about the package's settings file that says nothing useful.

The spawn environment is `dotnetSpawnEnv` (no worktree directories on `PATH`) plus `DOTNET_ROOT` set to the install holding the .NET 10 runtime, which is how csharp-ls's launcher finds it, and `MSBUILDDISABLENODEREUSE`, `DOTNET_CLI_USE_MSBUILD_SERVER=0` and `UseSharedCompilation=false`, so no build node outlives the server. `MSBUILDDISABLENUGETSDKRESOLVER` stops MSBuild's NuGet SDK resolver, which would download an uncached SDK while a project evaluates, with no restore involved; it cannot be limited to cached SDKs, so `nugetSdkNotices` names the projects that lose theirs.

## `dotnet` and trust

`prepareDotnet` is the one way to get a `dotnet` to run. In a trusted repository it only needs a `dotnet` to exist: trust covers an SDK that `global.json` selects from the repository and the version a version manager's shim reads from it, as in the user's terminal. In any other repository `isDotnetSafeToRun` must pass and a shim (`isVersionManagerShim`) does not run. csharp-ls itself runs only in a trusted repository, so it uses a shim like any other `dotnet`.

## What loads

`solutionTarget` passes `--solution` for the single solution at the root, else the first solution by path, which is what csharp-ls's own search takes, so the choice is known and can be named in the notice. With no solution csharp-ls loads every project. `solutionProjects` reads a solution's text for the projects it lists, so unrestored projects it does not list (samples beside a root solution) neither hold the gate nor get a notice. A failed project is only a `window/logMessage` from csharp-ls; `handleServerFrame` collects these and sends one warning naming them.

## Registrations

csharp-ls registers nearly every feature dynamically, including text sync. `withClientRegistrations` rewrites what the client receives: `textDocument/semanticTokens`, the LSP's name for the registration, becomes the `textDocument/semanticTokens/full` that monaco-lsp-client keys its capability on, and `textDocument/codeLens` is dropped, since its lenses are reference counts with a command nothing runs.

## Scope

`--features metadata-uris` is off: definition into a library returns nothing rather than a `csharp:/` URI that needs client support to open. Completion lists imported names only; a code action adds a `using`.

## Network

After changing the manager or the accepted versions, run [audit-csharp-lsp.ts](../../scripts/network-audit/audit-csharp-lsp.ts) against a restored copy of a real project, including one naming an uncached NuGet SDK, and its `--control`. It runs csharp-ls behind the real server under [connect-log.c](../../scripts/network-audit/connect-log.c) with a real file open, including children and code action resolves. It needs a copy of .NET signed ad hoc, as its header explains.
