---
title: Go
description: Go language features from gopls, with navigation, rename, quick fixes, inlay hints and go.mod support.
order: 13.5
---

The Go server starts the first time you open a `.go`, `go.mod`, `go.sum` or `go.work` file, and stops when none remain open. Loxel bundles [gopls](https://go.dev/gopls/), but Go itself must be installed and on your `PATH`, because gopls runs `go` to understand a project. If it is missing, the status bar shows gopls as stopped, and hovering it says why. Install Go, then click that status bar item or run **Restart Language Servers**.

## What you get

Go files get diagnostics, hover, go-to-definition (into the standard library and downloaded modules too), references, rename across files, document and workspace symbols, completion including packages you have not imported yet, signature help, quick fixes, organize imports, folding and semantic highlighting.

Inlay hints show the types of assigned and `range` variables, parameter names at call sites, inferred type arguments and constant values.

In `go.mod`, you also get hover, links, quick fixes and two lenses at the top of the file: **Run go mod tidy** and **Create vendor directory**.

## Modules and toolchains

Loxel does not download modules or Go toolchains. You do that from a terminal, and Loxel works with what is on your machine. A warning tells you what to run in these two cases:

- **Modules missing from the module cache.** Your own code and the standard library keep working, but imports of those modules do not resolve. Run `go mod download`, or `go get <module>` for a new dependency, then run **Restart Language Servers**.
- **`go.mod` needs a newer Go than the one installed.** The module does not load. Install the version the warning names, then run **Restart Language Servers**.

**Run go mod tidy** and **Create vendor directory** work once the modules they need are in the module cache. Checking for module upgrades and `go get` quick fixes are not offered, since they need the network; run those commands in a terminal.

## Monorepos and build tags

One server covers the whole project, and each module loads the first time you open one of its files. In a repository with several modules and no `go.work`, rename, references and workspace symbols cover the modules of the files you have opened. Add a `go.work` to span them all.

Workspace symbols list your project's own symbols, not those of the standard library or dependencies. Go-to-definition still reaches those.

Files excluded by build tags on your platform have reduced features.

Renaming a symbol from a `vendor/` directory edits the vendored copy. `go mod vendor` restores it.

---

## See also

- [Language Intelligence](/docs/language-intelligence) — the features every language server provides, and how servers start and stop per worktree
