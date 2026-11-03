# C#

C# files are served by the user's own csharp-ls, behind a gate on repository trust and the restored state. Shared language-server architecture: [LANGUAGE_SERVERS.md](../LANGUAGE_SERVERS.md). What the environment module offers (finding `dotnet`, `global.json`, projects, the restored state) is in [csharp-env.ts](../../src/server/csharp-env.ts).

## Manager

| Manager                                                         | Binary      | Args                                           | Scope    | Flags and config                                                                                                                |
| --------------------------------------------------------------- | ----------- | ---------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [csharp-lsp-manager.ts](../../src/server/csharp-lsp-manager.ts) | `csharp-ls` | `--loglevel information`, `--solution`, always | worktree | no process until the gate opens; watched files; pulled settings (`csharp` section); code lenses dropped; `repoTrustRestriction` |

Nothing is bundled, so there is no manifest under `scripts/language-servers/` and no third-party notice.

## The gate

`gate` decides whether a process runs, in this order, stopping at the first answer: not trusted (nothing else runs, neither git nor `dotnet`), no project (quiet), no usable toolchain (a notice), nothing restored among what would load (a notice). A project with a layout `csharp-env.ts` cannot read counts as restored, since csharp-ls never restores anything itself and trust covers loading it.

### Connections with no process

`startSession` is overridden so a connection starts out held. A held connection has no process: it answers `initialize` with no capabilities and `shutdown`, refuses other requests, and sends the gate's notice as one `window/showMessage` warning. The client therefore stays connected with no features rather than stopped, which is what a closed gate means: a normal state, not a failed server. `serverFailureReason` would stop the client until a restart and read as an error.

Frames that arrive before the first decision are kept. If the first decision opens the gate, the base's `startSession` runs and they replay to the real server. Once a hold has answered `initialize`, opening the gate closes the socket with `LSP_RESTART_CLOSE_CODE`, and the reconnect goes through the gate again. Only one decision runs at a time per connection, with a deadline so a stalled git or `dotnet` cannot leave `initialize` unanswered; checks that could not finish keep the last notice and try again on the timer.

What makes a held connection decide again: `onRepoTrustChange` (a change restarts it, since `repoTrusted` is fixed for a connection), `subscribeCSharpRestore`, `notifyWatchedFilesChanged` for project, solution, `global.json` and tool manifest files, `onLoginShellEnvChange`, and, only while a toolchain notice is up, a timer, since nothing announces an install; a tick only decides when `toolchainStamp`, stats with no spawn, sees a difference, or the last decision could not finish. The login-shell environment is captured again at the start of that wait and on every sixth tick.

### Running sessions

csharp-ls reads a project's references when it loads and does not read `project.assets.json` again, reported or not. So a rewritten assets file (`watchedIgnoredGlobs`), a change in which projects are restored (`subscribeCSharpRestore`, which also covers layouts outside `obj`), or a discovered project list that differs from the generated solution's restarts the session once writes have settled, and the reconnect goes through the gate, which may hold it. These restarts share a cap per worktree, for a build target that rewrites its assets file while loading. The base restarts a session when trust changes.

## Finding csharp-ls

`pickCSharpLs` returns a command or a notice. A csharp-ls in the worktree's tool manifest outranks a global one and runs as `dotnet tool run csharp-ls --` from the worktree root: a repository that pins it chose a version matching its SDK, and the gate has already established trust. There is no fallback from it to a global tool, so what a repository asks for is what it gets or what the notice talks about.

Otherwise `resolveGlobalDotnetTool` looks on the `PATH` without the worktree's directories, then in `~/.dotnet/tools`, which is not always on the login-shell `PATH`; anything inside the worktree or tracked by git does not count. The version is read from the home directory, cached per binary, and compared with `MIN_CSHARP_LS_VERSION`, the first release with `csharp.analyzersEnabled`.

The notices lead with the step that works, because `dotnet tool install` under an SDK older than 10, including an older one `global.json` selects, fails with an error about the package's settings file that says nothing useful.

The spawn environment is `dotnetSpawnEnv` (no worktree directories on `PATH`) plus `DOTNET_ROOT` set to the install holding the .NET 10 runtime, which is how csharp-ls's launcher finds it, and `MSBUILDDISABLENODEREUSE`, `DOTNET_CLI_USE_MSBUILD_SERVER=0` and `UseSharedCompilation=false`, so no build node outlives the server. `MSBUILDDISABLENUGETSDKRESOLVER` stops MSBuild's NuGet SDK resolver, which would download an uncached SDK while a project evaluates, with no restore involved; it cannot be limited to cached SDKs, so `nugetSdkNotices` names the projects that lose theirs.

## `dotnet` and trust

`prepareDotnet` is the one way to get a `dotnet` to run. In a trusted repository it only needs a `dotnet` to exist: trust covers an SDK that `global.json` selects from the repository and the version a version manager's shim reads from it, as in the user's terminal. In any other repository `isDotnetSafeToRun` must pass and a shim (`isVersionManagerShim`) does not run. csharp-ls itself runs only in a trusted repository, so it uses a shim like any other `dotnet`.

## What loads

`loadTarget` passes `--solution` for the worktree's chosen solution while discovery still lists it, else `automaticCSharpSolution` from [csharp-env.ts](../../src/server/csharp-env.ts): the single solution at the root, else the first solution by path, which is what csharp-ls's own search takes, so the choice is known and can be named in the notice. With no solution, csharp-ls still gets `--solution`, because without it csharp-ls searches the disk, past what `discoverCSharpProjects` lists. [csharp-projects-solution.ts](../../src/server/csharp-projects-solution.ts) writes one listing every discovered project, restored or not, to the state directory, so it loads exactly the projects Loxel discovered and what they reference. `openGate` writes it, since only the decision that opens the gate may. It is private, keeps its name for the worktree, is written only when its content changes, and goes when the worktree is removed; if it cannot be written the connection stays held. It is a `.sln` because SDKs before .NET 9 cannot read a `.slnx`, with each project in a solution folder of its own because a solution refuses two projects with the same file name. A path the format cannot hold (a double quote, a backslash or a line break) is left out and logged. A project loaded this way sees `$(SolutionDir)` as the state directory. `solutionProjects` reads a solution's text, or a `.slnf`'s JSON, for the projects it lists, so unrestored projects it does not list (samples beside a root solution) neither hold the gate nor get a notice. A failed project is only a `window/logMessage` from csharp-ls; `handleServerFrame` collects these and sends one warning naming them.

## Status item and solution choice

The [toolchain status item](../LANGUAGE_SERVERS.md#toolchain-status-items) shows what the manager decided rather than deciding anything itself. Every decision publishes a `CSharpLspState` to [csharp-lsp-state.ts](../../src/server/csharp-lsp-state.ts): `gate` carries a closed gate's state and the words of its notice, `buildSession` publishes `running` with the target, projects and SDK, and `onSessionClosed` publishes `stopped`. So the state follows everything that makes a connection decide again. Nothing is known for a worktree until its first connection, which an open C# file makes; until then the item shows nothing, and a later connection replaces what the last one left. [csharp-toolchain-status.ts](../../src/server/csharp-toolchain-status.ts) on the server owns `GET /api/csharp-status?wt=`, `GET /api/csharp-status/solutions?wt=` and `POST /api/csharp-status/solution`. It adds what the gate does not establish: `chosenMissing`, and, since the gate runs no git in an untrusted repository, whether that repository has a project at all, from `discoverCSharpProjects`, so that one without shows nothing. In the renderer, [csharp-solution.ts](../../src/lib/csharp-solution.ts) holds the labels and the picker, run by the `csharp.selectSolution` action, [CSharpStatus.tsx](../../src/components/panels/CSharpStatus.tsx) the item, [csharp-env-client.ts](../../src/api/csharp-env-client.ts) the calls, all registered in [csharp-toolchain-status.ts](../../src/lib/csharp-toolchain-status.ts).

The choice is in [csharp-solution-store.ts](../../src/server/csharp-solution-store.ts), per worktree, as an absolute path, and goes with the worktree. The route takes only what `csharpSelectableSolutions` lists and whose real path lies in the worktree. `.sln`, `.slnx` and `.slnf` load through `--solution`; a `.csproj` does not (csharp-ls reports that the solution could not be loaded, and runs with nothing), so it is not offered. A choice stays stored when its file goes away, and applies again when the file returns. `restartForTarget` restarts a running server when what it should load differs from what it was told, on a change of the choice or of a project file, while one is stored; a held connection decides again. A choice is only an input to `loadTarget`, behind the gate's first step, so an untrusted repository still loads nothing.

A solution csharp-ls fails to load leaves it running with no projects and sends its own `window/showMessage`, which `handleServerFrame` also turns into the `load-failed` state.

## Registrations

csharp-ls registers nearly every feature dynamically, including text sync. `withClientRegistrations` rewrites what the client receives: `textDocument/semanticTokens`, the LSP's name for the registration, becomes the `textDocument/semanticTokens/full` that monaco-lsp-client keys its capability on, and `textDocument/codeLens` is dropped, since its lenses are reference counts with a command nothing runs.

## Scope

`--features metadata-uris` is off: definition into a library returns nothing rather than a `csharp:/` URI that needs client support to open. Completion lists imported names only; a code action adds a `using`.

## Network

After changing the manager or the accepted versions, run [audit-csharp-lsp.ts](../../scripts/network-audit/audit-csharp-lsp.ts) against a restored copy of a real project, including one naming an uncached NuGet SDK, and its `--control`. It runs csharp-ls behind the real server under [connect-log.c](../../scripts/network-audit/connect-log.c) with a real file open, including children and code action resolves. It needs a copy of .NET signed ad hoc, as its header explains.
