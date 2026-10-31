# Go

Go files are served by gopls and formatted by gofmt or golangci-lint. Shared language-server architecture: [LANGUAGE_SERVERS.md](../LANGUAGE_SERVERS.md).

## Manager

| Manager                                                 | Binary  | Args    | Scope    | Flags and config                                                                                                                         |
| ------------------------------------------------------- | ------- | ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [go-lsp-manager.ts](../../src/server/go-lsp-manager.ts) | `gopls` | `serve` | worktree | watched files; pulled settings (`gopls` section); fixed Go environment; hides some code actions; reports setup problems as `showMessage` |

## Binary

gopls publishes no release binaries, so [build-gopls.ts](../../scripts/build-gopls.ts) compiles it with the pinned toolchain from [go-toolchain.ts](../../scripts/go-toolchain.ts), in a temporary copy of [scripts/gopls-module/](../../scripts/gopls-module/), whose `go.mod` and full `go.sum` pin every dependency. `GOENV=off`, `GOWORK=off`, a private `HOME`, `GOPATH` and `GOCACHE`, and `GOTOOLCHAIN=local` keep the build out of the machine's own Go setup. The binary is `CGO_ENABLED=0 -trimpath -ldflags='-s -w'`, 27-30 MiB. Upgrading is described at the top of the script.

## Environment

gopls runs `go`, and `go` runs other tools from `PATH`, so the spawn `PATH` is the login-shell one with the worktree's directories removed (`pathOutsideWorktree`, as for basedpyright). Before spawning, the manager looks for `go` on that `PATH`, refreshing the login-shell environment on a miss. Without it, `resolveBinary` returns null and `serverFailureReason` gives `GO_NOT_FOUND_REASON`, so the client shows a stopped server instead of gopls repeating `go command required` and answering `no views`.

`GO_ENV` is always set: `GOPROXY=off`, `GOTOOLCHAIN=local`, `GOSUMDB=off` and `GONOPROXY=none`. Loxel never downloads modules or toolchains. The last two matter: with only the first two, `go` still contacts the checksum database for a cached module with no `go.sum` entry, and fetches modules matching `GOPRIVATE` directly with `git`. Every lens and feature was checked to make no connection under this environment, at the socket level.

## Setup problems

gopls reports a `go.mod` needing a newer Go as a log-level `showMessage` and a missing module as `could not import` diagnostics, neither of which says what to do. `goSetupProblem` recognizes them in server frames, and `report` sends one warning `window/showMessage` per session and kind, which the client's `showMessages` shows as a toast, once per distinct text while Loxel runs. A command that fails on a module lookup is covered too, since `LspServerCommands` only logs command errors.

Neither problem recovers on its own: gopls does not notice the module cache or a new `go`, and `didChangeWatchedFiles`, an edit, and `didChangeConfiguration` with unchanged settings do not reload. A restart does, so the warning says to run Restart Language Servers. After a newer-Go warning, the next start refreshes the login-shell environment first, since the new Go may be in a directory new to `PATH`.

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
- The cwd is the file's directory, because gofumpt and goimports read `go.mod` from the cwd only. `PATH` is the login-shell one without the worktree's directories or relative entries, so `detect` and the spawn agree and nothing from the repository runs. A manual override given as a path into the worktree is the user's explicit choice and still runs.
- `GO_ENV` is set for every Go formatter, since golangci-lint runs `go`. `detect` is synchronous, so the `go env GOROOT` lookup for a `gofmt` missing from `PATH` (a `go` wrapper) is in `spawnOptions`. `GOTOOLCHAIN=local` keeps that lookup from starting a toolchain download. These were checked at the socket level, with re-signed copies of `go` and `gofmt` because the official binaries are hardened against `DYLD_INSERT_LIBRARIES`.

## Other behavior

- The only dynamic registration is `didChangeWatchedFiles`; without forwarding, a new file is never picked up.
- File kind follows the extension, not the language ID. `go.mod` gets diagnostics, hover, links, lenses and quick fixes, `go.work` hover and completion, `go.sum` nothing. `gopls.tidy` returns `workspace/applyEdit` and writes nothing itself.
- Rename returns `documentChanges` only, with `version: 0` for unopened files.
- One workspace folder at the root works for monorepos: gopls makes a view per module on first open, and a root with no `go.mod` works.
