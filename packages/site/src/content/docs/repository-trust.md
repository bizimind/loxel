---
title: Repository Trust
description: How Loxel decides whether it may run a repository's code, and how to trust a repository or stop trusting it.
order: 13.2
---

Some features can do more by running code from the repository you opened: build scripts, project plugins, a linter's or formatter's config file, the repository's worktree hooks. A repository you just cloned could put anything there, so a feature that depends on trust works in a restricted form until you say you trust the repository.

A project you create from scratch with **New Project** starts trusted, since everything in it is yours. Every other repository starts untrusted, including ones you clone and projects you already had. Editing, Git and everything else keep working.

## Trusting a repository

Loxel doesn't ask when you open a project. When a feature is restricted for lack of trust, a notice appears once and the status bar shows **Restricted**. Hover it to see what is held back, and click it to choose. **Manage Repository Trust** in the command palette opens the same choice at any time.

Trust belongs to the repository, not to a worktree, so a new worktree of a trusted repository doesn't ask again. Moving or replacing the repository's folder means choosing again.

Worktree hooks run in trusted repositories. When Loxel creates a worktree in a repository you haven't trusted, it doesn't run the repository's `init.wt.sh`: it says so and offers to trust the repository and run the hook in the new worktree. Removing a worktree there doesn't run `clean.wt.sh`, and the removal dialog offers to trust the repository first. Running `wt` in a terminal is your own command and runs the hooks as always.

Trust a repository only if you would be willing to run its code yourself. Language servers that depend on trust restart as soon as you choose.

## What waits for trust

In a repository you haven't trusted:

- **Astro**: the Astro language server doesn't run, since it loads your project's own TypeScript and packages. It starts as soon as you trust the repository.
- **C and C++**: on macOS, Loxel's own clangd runs instead of yours. clangd asks only compilers in system folders for include paths, and leaves out compile flags that write output files or pass options through to the compiler. A `.clangd` that names a compile database outside the worktree turns off the background index. See [C and C++](/docs/languages/c-cpp).
- **C#**: projects don't load, so C# files get syntax highlighting only. Format on save doesn't run the CSharpier your project's tool manifest names, or a version manager's `dotnet`. See [C#](/docs/languages/csharp).
- **Docker**: Dockerfiles aren't linted with Docker's build checks. The Dockerfile language server's own checks work as usual.
- **Go**: golangci-lint doesn't run. gopls and format on save work as usual. See [Go](/docs/languages/go).
- **Java**: Maven and Gradle projects aren't loaded, so each Java file is analyzed on its own. Checkstyle doesn't run. A JDK inside the worktree isn't used, and doesn't reach new terminals. See [Java](/docs/languages/java).
- **JavaScript and TypeScript**: ESLint, oxlint and Biome's linter don't run. Format on save doesn't run Biome, Prettier or oxfmt, or formatters from the project's `node_modules`. The TypeScript language server works as usual. See [JavaScript](/docs/languages/javascript).
- **Python**: mypy doesn't run, so basedpyright checks types. A Python installed through a version manager such as pyenv shows its global version in the status bar. See [Python](/docs/languages/python).
- **Rust**: build scripts, proc macros and `cargo check` don't run, and flags from `.cargo/config.toml` don't apply to analysis. See [Rust](/docs/languages/rust).
- **Terraform**: Terraform itself doesn't run, so provider schemas come from the language server's built-in set rather than your initialized providers.
- **Every language**: format on save doesn't run a formatter override that names a file by its path in the repository, or one that runs a tool your project's .NET tool manifest names.

Kotlin, TOML and YAML features work the same in every repository, and so do gofmt, rustfmt, clang-format, ktfmt, ktlint and the Java formatters: they read the repository's files as settings and run nothing from it.

## Stop trusting a repository

A trusted repository shows a shield in the status bar. Click it, or run **Manage Repository Trust**, to stop trusting it. Language servers that depend on trust restart restricted. When a language server that runs builds (Rust, C#, Go) crashes, Loxel also stops the builds it had running, except one started in the few seconds before the crash. A process that the repository's code started and detached to run on its own can keep running after you stop trusting the repository.

## What trust covers

Trust lets the repository's own code run. It doesn't let Loxel download or install anything: Loxel and the tools it runs never fetch dependencies or toolchains, in a repository you trust as in any other, and installing them stays yours. Code that a trusted repository runs, such as a build script or a project plugin, can reach the network itself, as it can when you build the project in a terminal.

Trust is per repository, and a nested repository has its own. A trusted repository's own project files are still loaded as they are written, including the nested repositories they name, such as a solution that references a project in a submodule.

Nothing in a repository can mark itself as trusted. Your answer is stored in Loxel's own state on your machine and is never sent anywhere.
