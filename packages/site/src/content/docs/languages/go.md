---
title: Go
description: Go language features from gopls, with navigation, rename, quick fixes, inlay hints, go.mod support and format on save.
order: 13.5
---

The Go server starts the first time you open a `.go`, `go.mod`, `go.sum` or `go.work` file, and stops when none remain open. Loxel uses your own [gopls](https://go.dev/gopls/) or bundles one, but Go itself must be installed and on your `PATH`, because gopls runs `go` to understand a project. If it is missing, the status bar shows gopls as stopped, and hovering it says why. Install Go, then click the Go item or the gopls item in the status bar.

## Go in the status bar

While a `.go`, `go.mod`, `go.work` or `go.sum` file is active, the status bar shows the Go your project uses, such as **Go 1.27.3**. Hover it for the path of `go`, where it comes from, `GOROOT`, the module or workspace file, and the gopls in use. By default Loxel uses the first `go` on your login shell's `PATH`, and ignores any inside the project. With a version manager such as asdf, mise or goenv, that is its global version: a pin for one project is not followed. A toolchain the project asks for that is already in your module cache is used instead, see [Toolchains your project asks for](#toolchains-your-project-asks-for).

It turns to a warning in these cases:

- **Go not found.** Go is not installed or not on your `PATH`. Loxel does not install Go. Install it, then click the item.
- **The chosen Go cannot be used.** The Go you chose for this worktree is gone. Loxel goes back to automatic detection until it returns or you choose another, and the hover names it.
- **Go did not report its version.** The `go` that was found did not answer. The hover names it.
- **The project needs a newer Go.** The `go` line of the `go.mod` or `go.work` at the root of the worktree is newer than the Go in use and that version is not in your module cache. The hover says which version it needs. Loxel does not download Go. Run `go version` in the project from a terminal, which downloads it, or put that version on your `PATH`.

A newer `toolchain` line is not a warning, since the project still loads with the Go in use. The hover mentions it. Only the `go.mod` and `go.work` at the root of the worktree are compared.

When the Go in use changes, gopls restarts by itself. If you installed Go in a directory that is new to your `PATH`, click the item, or run **Go: Select Toolchain** from the command palette (`Cmd+Shift+P`), so that Loxel reads your `PATH` again.

## Choosing a Go for a worktree

Click the Go item, or run **Go: Select Toolchain**, to choose which Go a worktree uses. The list offers:

- **Use automatic detection**, the default.
- **Enter a path to Go**, a `go` binary or a `GOROOT`. `~/` works. A Go inside the worktree, or one a repository tracks, is refused.
- Every Go found on your machine, with its version and path: the `go` on your `PATH` or behind a version manager's shim, `~/sdk/go*`, `/usr/local/go`, Homebrew's `go` and `go@*`, mise and asdf installs, and toolchains in your module cache.

The list only shows what is already on your machine, and Loxel never downloads a Go. The choice applies to that worktree only and is remembered. gopls and format on save follow it right away. New terminals and the coding agent's commands in that worktree get the chosen Go's `bin` first on `PATH`. On macOS, a login shell's startup can move another directory ahead of it in a terminal.

## Toolchains your project asks for

Go can switch to the version a project asks for, downloading it once into your module cache. In a terminal, `go version` in such a project prints the project's version. Loxel uses that same copy when it is already there: if the `go` or `toolchain` line at the root of the worktree asks for newer than the Go on your `PATH`, and that exact version is in your module cache, the status bar shows it, the hover says it comes from the module cache, and gopls and format on save use it. Terminals are left as they are, since `go` switches by itself there.

If it is not there, run `go version` in the project from a terminal. Once the download finishes, Loxel picks it up and gopls restarts by itself. A Go you chose for the worktree stays in use whatever the project asks for.

## What you get

Go files get diagnostics, hover, go-to-definition (into the standard library and downloaded modules too), references, rename across files, document and workspace symbols, completion including packages you have not imported yet, signature help, quick fixes, organize imports, folding and semantic highlighting.

Inlay hints show the types of assigned and `range` variables, parameter names at call sites, inferred type arguments and constant values.

In `go.mod`, you also get hover, links, quick fixes and two lenses at the top of the file: **Run go mod tidy** and **Create vendor directory**.

## Modules and toolchains

Loxel does not download modules or Go toolchains. You do that from a terminal, and Loxel works with what is on your machine. A warning tells you what to run in these two cases:

- **Modules missing from the module cache.** Your own code and the standard library keep working, but imports of those modules do not resolve. Run `go mod download`, or `go get <module>` for a new dependency, then run **Restart Language Servers**.
- **`go.mod` needs a newer Go than the one in use, and it is not in your module cache.** The module does not load. Run `go version` in the project, or put the version the warning names on your `PATH`, and gopls restarts.

**Run go mod tidy** and **Create vendor directory** work once the modules they need are in the module cache. Checking for module upgrades and `go get` quick fixes are not offered, since they need the network; run those commands in a terminal.

If `gopls` is on your `PATH`, Loxel uses it, at any version. Otherwise it uses the one it bundles. Hover the Go item to see which is in use.

## Format on save

Files in a Go module or workspace (a `go.mod` or `go.work` in the file's folder or a parent) are formatted with `gofmt` when you save. If the closest `.golangci.yml`, `.golangci.yaml`, `.golangci.toml` or `.golangci.json` has `version: "2"` and enables formatters under `formatters.enable`, and `golangci-lint` v2 is installed, Loxel runs `golangci-lint fmt` with that config instead, so your gci sections, gofumpt rules and other formatter settings apply. A config in a nested module replaces the root's, as it does for `golangci-lint` itself, so a nested config that enables no formatters means `gofmt` there.

Loxel leaves some files alone: those in `vendor/` and `testdata/`, those your config's `formatters.exclusions.paths` excludes, and `.go` files with no module or selecting config above them. If a pattern in `formatters.exclusions.paths` is too complex for Loxel to evaluate, files under that config are left alone too. To format those, or to use `goimports` or `gofumpt` on their own, add a manual override in **Settings > Editor**.

If `golangci-lint` can't load the config, or your installed version is older than v2, the file is saved unformatted. Run `golangci-lint version` and `golangci-lint config verify` in a terminal to see why. A file with a syntax error is also saved as it is. Formatting never downloads anything.

## Monorepos and build tags

One server covers the whole project, and each module loads the first time you open one of its files. In a repository with several modules and no `go.work`, rename, references and workspace symbols cover the modules of the files you have opened. Add a `go.work` to span them all.

Workspace symbols list your project's own symbols, not those of the standard library or dependencies. Go-to-definition still reaches those.

Files excluded by build tags on your platform have reduced features.

Renaming a symbol from a `vendor/` directory edits the vendored copy. `go mod vendor` restores it.

---

## See also

- [Language Intelligence](/docs/language-intelligence) — the features every language server provides, and how servers start and stop per worktree
