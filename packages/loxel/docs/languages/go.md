# Go

Go files are served by gopls and formatted by gofmt or golangci-lint. Shared language-server architecture: [LANGUAGE_SERVERS.md](../LANGUAGE_SERVERS.md).

## Manager

| Manager                                                 | Binary  | Args    | Scope    | Flags and config                                                                                                                                                                         |
| ------------------------------------------------------- | ------- | ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [go-lsp-manager.ts](../../src/server/go-lsp-manager.ts) | `gopls` | `serve` | worktree | watched files; pulled settings (`gopls` section); fixed Go environment; restarts when `go` or the gopls to use changes; hides some code actions; reports setup problems as `showMessage` |

## Binary

gopls publishes no release binaries, so [build-gopls.ts](../../scripts/build-gopls.ts) compiles it with the pinned toolchain from [go-toolchain.ts](../../scripts/go-toolchain.ts), in a temporary copy of [scripts/gopls-module/](../../scripts/gopls-module/), whose `go.mod` and full `go.sum` pin every dependency. `GOENV=off`, `GOWORK=off`, a private `HOME`, `GOPATH` and `GOCACHE`, and `GOTOOLCHAIN=local` keep the build out of the machine's own Go setup. The binary is `CGO_ENABLED=0 -trimpath -ldflags='-s -w'`, 27-30 MiB. Upgrading is described at the top of the script.

`GoEnv.gopls` names a `gopls` on the toolchain `PATH`, found by `trustedGoTool`, and the manager runs it at any version; the bundled binary is the fallback when there is none. A binary in the worktree through a symlink, a shim, or one tracked by a repository (`isShippedByRepo`) counts as none. Nothing asks gopls its version: a reinstall at the same path is told by the file's identity.

## Toolchain

[go-env.ts](../../src/server/go-env.ts) is the one source of truth for a worktree's Go toolchain, memoized and subscribable per worktree. Its consumers are the manager, the formatter, the terminal and agent environment ([go-toolchain-env.ts](../../src/server/go-toolchain-env.ts)) and the status item ([go-toolchain-status.ts](../../src/server/go-toolchain-status.ts), [GoToolchainStatus.tsx](../../src/components/panels/GoToolchainStatus.tsx), [go-toolchain.ts](../../src/lib/go-toolchain.ts)), which reach it through the seam in [Toolchain status items](../LANGUAGE_SERVERS.md#toolchain-status-items). Whatever runs `go` for a worktree, the manager and the formatter alike, takes its `PATH` and environment from `goSpawnEnv`. `trustedGoTool` finds the `gopls` that `GoEnv` names.

- **`PATH`.** `goToolPath` is the login-shell `PATH` without relative entries and the worktree's directories, by name or through a symlink, since `go` runs other tools from it. A `go` refused by the trust rule is not passed over for a later one, because whatever runs `go` would still find it first: the worktree has no `go`.
- **`GO_ENV`** is set on every run: `GOPROXY=off`, `GOTOOLCHAIN=local`, `GOSUMDB=off` and `GONOPROXY=none`. Loxel never downloads modules or toolchains, and even `go env` starts a toolchain download in a project with a newer `toolchain` line without `GOTOOLCHAIN=local`. The last two matter: with only the first two, `go` still contacts the checksum database for a cached module with no `go.sum` entry, and fetches modules matching `GOPRIVATE` directly with `git`. Every lens and feature was checked to make no connection under this environment, at the socket level.
- **Version managers.** With a shim from asdf, mise or goenv first on `PATH`, `go env GOROOT` from the home directory gives the manager's global Go. That `$GOROOT/bin/go` is what runs in the worktree, and it comes first on `goSpawnEnv`'s `PATH`, which has no shim directories. A project's version-manager pin is not followed.
- **Resolution.** `GoEnv.source` says which of three a worktree gets. A choice stored for the worktree (`chosen`) comes first; then what detection finds on `PATH` (`path`), or the project's version from the module cache (`module-cache`). `go env -json` from that `go`, in the worktree, gives the version and paths, and works on a `go.mod` it cannot load. Without a usable `go` the result is null, never an error; a `go` that does not answer has a null `version`. For the two sources that are not simply the `PATH`'s, `goSpawnEnv` puts `$GOROOT/bin` first and sets `GOROOT`, since a login shell's exported one would select another standard library, and `go env` runs without the exported one to learn its own.
- **Chosen Go.** [go-toolchain-store.ts](../../src/server/go-toolchain-store.ts) keeps one absolute `go` path per worktree in the store database, written only by the choice route. [go-toolchain-candidates.ts](../../src/server/go-toolchain-candidates.ts) lists what the picker offers and checks an entered path: it applies the trust rule before anything runs, turns a shim into the Go behind it, and asks `go version` from the home directory. A stored `go` that is gone, refused or reports a refused GOROOT falls through to detection on each resolution, with `GoEnvResponse.chosen` still naming it for the warning state.
- **Module cache.** Only after a `GOTOOLCHAIN=local` resolution shows the project asks for newer, `moduleCacheGoEnv` looks for exactly `GOMODCACHE/golang.org/toolchain@v0.0.1-go<version>.<GOHOSTOS>-<GOHOSTARCH>`, as `go` itself names it, with a language version like `1.26` meaning its first release, `1.26.0`. It tries the highest requested version, then the `go` line. The directory and its `bin/go` must stay under `GOMODCACHE` after symlink resolution, be executable (`go` sets the bits on first use), pass the trust rule and report the expected version. `GOMODCACHE` comes from `go env`. `GOTOOLCHAIN=auto` is not used: with `GOPROXY=off` and an uncached version, `go env` itself fails with `toolchain not available` and gopls loads no view. A cached `go` run with `GOTOOLCHAIN=local` reports its own version. A chosen Go is used as it is, with no cached substitute.
- **Terminals and the agent.** [go-toolchain-env.ts](../../src/server/go-toolchain-env.ts) puts a chosen Go's `$GOROOT/bin` first on `PATH`, and does nothing without a choice, without even running `go`. Detection changes nothing there, cached toolchains included, because a terminal's `go` switches by itself. `GO_ENV` stays out, since `go` in a terminal is the user's own.
- **Project versions.** The root `go.work` and `go.mod` are read directly, taking the highest of each line, and a line counts only when its whole value has the exact shape of a Go version, because module cache lookups build a directory name from it. With `GOTOOLCHAIN=local` a newer `go` line stops the module loading, so it is `newerGoNeeded`; a newer `toolchain` line does not, so it is only `newerToolchainSuggested`. Nested modules are out of scope.
- **Re-resolving.** `watchGoEnv` watches the root files, `go` and `gopls` in every `PATH` directory (the deepest existing ancestor of a missing one), the directory `go` resolves to, the chosen `go`, and each toolchain directory the project asks for in the module cache (non-recursively, with its `bin/go` once it exists, since `go` sets the executable bits after unpacking). A choice changing re-resolves through the seam's `onOverrideChange`, and `getGoEnv` also notices one the store's hook has not reported yet. A watch whose targets did not change is kept, since a new one can miss a change while it is armed. `refreshAllGoEnvs` follows login-shell captures that changed `PATH` or a `GO*` variable.

## Starting and restarting

Before spawning, `resolveBinary` asks for the toolchain, capturing the login-shell environment again on a miss. Without a `go`, it returns null and `serverFailureReason` gives `GO_NOT_FOUND_REASON`, so the client shows a stopped server instead of gopls repeating `go command required` and answering `no views`. A stopped server has no socket for the server to close, so it starts again from the client: **Restart Language Servers**, the stopped status item, or the Go status item, whose picker (`selectGoToolchain`) starts with `refreshGoToolchain`: it captures the environment unthrottled, resolves, and restarts stopped servers once `go` is found. Making a choice restarts them too.

A running session subscribes to the toolchain. When the `go` binary, its version, its GOROOT, the gopls to use or that file differs from what the session started with, `restartIfChanged` closes the socket with `LSP_RESTART_CLOSE_CODE` and the client reconnects, since gopls does not notice a new `go` by itself. A `go` that is gone or does not answer leaves gopls running, because it may be an install in progress; the status item shows the state until a working `go` decides.

## Setup problems

gopls reports a `go.mod` needing a newer Go as a log-level `showMessage` and a missing module as `could not import` diagnostics, neither of which says what to do. `goSetupProblem` recognizes them in server frames, and `report` sends one warning `window/showMessage` per session and kind, which the client's `showMessages` shows as a toast, once per distinct text while Loxel runs. A command that fails on a module lookup is covered too, since `LspServerCommands` only logs command errors.

A missing module does not recover on its own: gopls does not notice the module cache, and `didChangeWatchedFiles`, an edit, and `didChangeConfiguration` with unchanged settings do not reload. A restart does, so that warning says to run Restart Language Servers. After a newer-Go warning, the next start captures the login-shell environment first, since the new Go may be in a directory new to `PATH`.

## Settings

gopls pulls settings with `workspace/configuration` and must get an answer: an error is fatal to loading the workspace and no answer blocks forever. `workspaceConfiguration` answers `GOPLS_SETTINGS` for the `gopls` section and `{}` for any other.

- `semanticTokens` is on, without `comment`, `string`, `number` and `operator`, which stay with TextMate.
- `hints` turns on what Python shows inline.
- `codelenses` keeps `tidy` and `vendor`. `test` has no runner in Loxel, `generate`, `regenerate_cgo` and `run_govulncheck` run with no visible output since the client declares no progress support, and `upgrade_dependency` always needs the network.
- `symbolScope: "workspace"` keeps vendored, dependency and standard-library symbols out of Go to Symbol.
- `vulncheck: "Off"` stops the default prompt and the check it can run against an online database, which a saved preference from another gopls client would otherwise trigger when a `go.mod` changes.
- `usePlaceholders` fills a completed call's parameters as snippet placeholders. gopls escapes `$` in snippet text, so completions need no `disableCompletionSnippets`.
- `staticcheck` stays off (940 MiB on a large project, and noisy). The hidden `pullDiagnostics` option is not set because it does not work properly; diagnostics are push.

## Hidden actions

`withoutHiddenActions` removes these from the initialize response and from every result array, so Loxel's code action commands and menus do not offer them:

- `source.doc`, `source.assembly`, `source.freesymbols`, `source.splitPackage` and `gopls.doc.features` start a local web page and announce it with `window/showDocument` or an info `showMessage`, which Loxel does not act on.
- `gopls.go_get_package`, `gopls.add_dependency`, the upgrade commands and vulncheck look modules up online.

## Format on save

[go-formatter.ts](../../src/server/go-formatter.ts) is the Go `LanguageFormatter` ([Formatting](../LANGUAGE_SERVERS.md#formatting)). The nearest `.golangci.*` decides alone, since golangci-lint never merges configs: `version: "2"` with a non-empty `formatters.enable`, and the binary on `PATH`, selects `golangci-lint fmt --stdin`. Otherwise `gofmt` runs inside a module or workspace, and nothing outside one. A config without formatters is still the nearest config, so the walk does not continue to a parent's. `gofmt` needs a module rather than running everywhere so that a repository with no Go module lists no Go formatter in Settings.

- `--config` is always passed, because golangci-lint's own search can leave the worktree. It is relative to the physical cwd because the seam's args are split on whitespace; a path that still has whitespace, possible only through a symlinked directory, means `gofmt` instead.
- stdin input is always `<standard input>` to golangci-lint, so it ignores `formatters.exclusions.paths`. `isExcluded` matches them itself, relative to `run.relative-path-mode`'s base. Go regular expressions are translated to JavaScript ones. A pattern with no equivalent, or estimated to backtrack for too long on the server's thread for that path, is logged and counts as excluding the file: leaving a file alone is easier to notice and undo than rewriting one the project excludes.
- The cwd is the file's directory, because gofumpt and goimports read `go.mod` from the cwd only. `PATH` and the environment come from `goSpawnEnv`, so `detect` and the spawn agree. A manual override given as a path into the worktree is the user's explicit choice and still runs.
- `GO_ENV` is set for every Go formatter, since golangci-lint runs `go`. `detect` is synchronous, so `spawnOptions` takes the worktree's Go from `getGoEnv`, within a deadline: `goSpawnEnv` puts a chosen or cached Go first, and its `GOROOT` also serves when the command or `go` is missing from that `PATH`. These were checked at the socket level, with re-signed copies of `go` and `gofmt` because the official binaries are hardened against `DYLD_INSERT_LIBRARIES`.

## Other behavior

- The only dynamic registration is `didChangeWatchedFiles`; without forwarding, a new file is never picked up.
- File kind follows the extension, not the language ID. `go.mod` gets diagnostics, hover, links, lenses and quick fixes, `go.work` hover and completion, `go.sum` nothing. `gopls.tidy` returns `workspace/applyEdit` and writes nothing itself.
- Rename returns `documentChanges` only, with `version: 0` for unopened files.
- One workspace folder at the root works for monorepos: gopls makes a view per module on first open, and a root with no `go.mod` works.
