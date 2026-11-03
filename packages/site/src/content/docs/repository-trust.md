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

In a repository you haven't trusted, format on save doesn't run Biome, Prettier or oxfmt, formatters from the project's `node_modules`, or a formatter override that names a file by its path in the repository, and a Python installed through a version manager such as pyenv shows its global version in the status bar.

Trust a repository only if you would be willing to run its code yourself. Language servers that depend on trust restart as soon as you choose.

## Stop trusting a repository

A trusted repository shows a shield in the status bar. Click it, or run **Manage Repository Trust**, to stop trusting it. Language servers that depend on trust restart restricted. Processes left behind by a language server that crashed, such as a build it started, aren't stopped and run until they finish. A process that the repository's code started and detached to run on its own can also keep running after you stop trusting the repository.

## What trust covers

Trust lets the repository's own code run. It doesn't let Loxel download or install anything: Loxel and the tools it runs never fetch dependencies or toolchains, in a repository you trust as in any other, and installing them stays yours. Code that a trusted repository runs, such as a build script or a project plugin, can reach the network itself, as it can when you build the project in a terminal.

Trust is per repository, and a nested repository has its own. A trusted repository's own project files are still loaded as they are written, including the nested repositories they name, such as a solution that references a project in a submodule.

Nothing in a repository can mark itself as trusted. Your answer is stored in Loxel's own state on your machine and is never sent anywhere.
