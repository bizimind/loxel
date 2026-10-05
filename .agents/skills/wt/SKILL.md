---
name: wt
description: >-
  How to use the `wt` git-worktree manager: creating/listing/viewing/renaming/removing
  worktrees, the repo layout, where init.wt.sh / clean.wt.sh / rename.wt.sh hooks go and
  what to put in them, the wt.sh shell helpers, and scripting wt with its JSON output. Use
  when setting up or working with git worktrees via `wt`, writing wt hook scripts, or
  parsing wt's output in a script.
---

# Using `wt`

`wt` is a configless git worktree manager: git itself is the database (`git worktree list`), with no config or state file. Per-worktree setup, teardown and rename fixups live in optional shell hooks at the repo root. A common use is one worktree per task, each running its own coding agent, removed once the work lands.

Full reference (every flag, the JSON shapes, the shell helpers, example hook sets, the library API, migrating from the old `wt.yaml` CLI): `packages/wt/README.md` in the loxel monorepo. Source: `packages/wt/src`.

## Commands

```sh
wt add [name]        # create a worktree, run init.wt.sh        (alias: create)
wt list              # list worktrees                           (alias: ls)
wt view [name]       # one worktree's branch, head, dirty count, upstream divergence
wt mv [old] <new>    # rename a worktree + its branch, run rename.wt.sh (aliases: rename, move)
wt remove [name]     # run clean.wt.sh, remove the worktree     (aliases: rm, delete)
wt version | update
```

Key flags: `-j` (JSON, all commands); `add -b <branch>` (check out an existing branch), `add --base <ref>` (start the new branch elsewhere); `mv --branch <b>` / `mv -B` (rename the branch to `<b>` / leave it alone), `mv -f` (locked worktree); `remove -f` (dirty worktree), `remove -d` / `-D` / `--keep-branch` (delete the branch if merged / even if unmerged / keep it without prompting). Run `wt <cmd> --help` for the rest.

**Running unattended (agents, scripts).** Always pass the worktree name and every decision as flags. Without a terminal, a missing name or an undecided choice (existing branch, dirty removal) is an error, never a prompt, and `remove`/`view`/`mv` never auto-pick a target. Without `-d`/`-D`, a non-interactive `remove` keeps the branch.

**Branches.** `wt add <name>` creates branch `<name>` from the remote default as of the last fetch (`origin/main`), or from `HEAD` when there is no `origin` default. It never fetches: run `git fetch` first for a newer base. The new branch tracks nothing. If branch `<name>` already exists, pass `-b <name>` to reuse it; if another worktree has it checked out, that is an error. `-d` deletes a branch only when it is merged into `HEAD` or the remote default.

**Renaming.** `wt mv <new>` renames the worktree you are in; `wt mv <old> <new>` renames another. The branch is renamed too only while it still matches the worktree name. A shell sitting in the renamed worktree is left on a dead path: `cd` to the reported `.path`.

**Removing.** A worktree with anything in `git status` needs `-f`. The main worktree of a non-bare repo cannot be renamed or removed; in the bare layout below, `.worktrees/main` is an ordinary worktree and can be.

## Repo layout

`wt` is most commonly used with a **bare repo**: every checkout, including `main`, is a worktree under `.worktrees/`, and the root holds git internals, local-only files and the hooks.

```
myrepo/                  # the bare repo  ← $WT_ROOT
  HEAD, objects/, ...    # git internals
  init.wt.sh             # runs after `wt add`     (in the new worktree)
  clean.wt.sh            # runs before `wt remove` (in the worktree being removed)
  rename.wt.sh           # runs after `wt mv`      (in the worktree at its new path)
  .env                   # local-only files live at the root, next to the hooks
  .worktrees/
    main/                # the main checkout is just another worktree
    feature-x/           # ← `wt add feature-x` lands here ($WT_PATH)
```

A plain `git clone --bare` sets no fetch refspec, so add one to get `origin/*` branches:

```sh
git clone --bare git@github.com:you/myrepo.git myrepo
cd myrepo
git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git fetch origin
wt add main -b main       # the default branch as the first worktree
```

In a regular (non-bare) repo, `$WT_ROOT` is the main worktree and added worktrees go in `<repo>/.worktrees/<name>` (wt adds it to `.git/info/exclude`). `WT_DIR` overrides the worktrees directory. Nested names work: `wt add feat/x` → `.worktrees/feat/x` on branch `feat/x`.

## Hooks

Optional scripts at the **repo root**, run with `bash`, with the worktree as the working directory. They get `WT_NAME`, `WT_PATH`, `WT_ROOT` and `WT_BRANCH` (`(detached)` when detached); `rename.wt.sh` also gets `WT_OLD_NAME`, `WT_OLD_PATH` and `WT_OLD_BRANCH`. A failing hook only prints a warning; it never aborts the command.

**`init.wt.sh`** rebuilds the local, git-ignored state a fresh checkout lacks: copy local-only files (`.env`, credentials), install dependencies, restore caches, start per-worktree services. Paths: `.` is the new worktree; `$WT_ROOT` is the repo root, which in a bare setup is the bare repo, not a checkout, so things that only exist in a checkout (built `node_modules`, submodule trees) come from `$WT_ROOT/.worktrees/main`.

```sh
#!/usr/bin/env bash
set -euo pipefail
cp "$WT_ROOT/.env" .                               # local-only files kept at the root
cp -Rc "$WT_ROOT/.worktrees/main/node_modules" .   # restore a cache (APFS: instant CoW)
pnpm install
docker run -d --name "myapp-${WT_NAME//\//-}" -p 5432 postgres:15
```

**`clean.wt.sh`** tears down what `init.wt.sh` started, keyed off `WT_NAME`. **`rename.wt.sh`** fixes up anything named after the old worktree (containers, generated config holding absolute paths), using the `WT_OLD_*` vars.

wt assigns no ports and generates no names: derive them from `WT_NAME` in the hooks. The README has complete hook sets.

## Scripting with JSON

With `-j`, stdout is only JSON; progress, hook output and prompts go to stderr. Errors are `{"error":true,"message":"..."}` on **stdout** with exit code 1, so re-surface `.message` when capturing output. Cancelling a prompt returns `{"aborted":true,"reason":"..."}` with exit code 0.

```sh
wt list -j | jq -r '.worktrees[] | select(.main|not) | .name'
cd "$(wt add feature-x -j | jq -r .path)"
wt remove feature-x -j -d | jq .branchDeleted
```

`add`, `view` and `mv` report the worktree's absolute `.path`; `mv` also reports `oldPath` and `branchRenamed`, `remove` reports `branchDeleted`. `branch` is `(detached)` for a detached worktree. For humans, `wt.sh` (sourced from the shell rc) provides `wta`/`wtv`/`wtm`, which cd into the result, and `wtr`.
