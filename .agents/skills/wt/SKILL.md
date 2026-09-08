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

`wt` is a configless git worktree manager: git itself is the database (`git worktree list`), with no config or state file. Per-worktree setup, teardown and rename fixups live in optional shell hooks at the repo root.

Source: `packages/wt` in the loxel monorepo.

## Why worktrees

`add` creates a worktree (and runs `init.wt.sh`), `remove` tears one down.

A common reason to want isolated worktrees is running **multiple coding agents in parallel** — each gets its own working dir, branch, dependencies and services from one shared repo, so they never step on each other. You spin up a worktree per task, run an agent in it, and remove it once the work lands. `init.wt.sh` (below) bootstraps each checkout so it's runnable immediately.

## Commands

```sh
wt add [name]        # create a worktree          (alias: create)
wt list              # list worktrees             (alias: ls)
wt view [name]       # show one worktree's details
wt mv [old] <new>    # rename a worktree + branch (aliases: rename, move)
wt remove [name]     # remove a worktree          (aliases: rm, delete)
wt version           # print the installed version
wt update            # update the binary in place
```

| Flag                    | Commands | Meaning                                                     |
| ----------------------- | -------- | ----------------------------------------------------------- |
| `-j`, `--json`          | all      | JSON result on stdout; prompts/progress stay on stderr      |
| `-b`, `--branch <b>`    | `add`    | Check out an existing branch instead of creating a new one  |
| `--branch <b>`          | `mv`     | Rename the branch to `<b>` instead of the new worktree name |
| `-B`, `--keep-branch`   | `mv`     | Rename the directory only, leave the branch alone           |
| `-f`, `--force`         | `mv`     | Move a locked worktree                                      |
| `-f`, `--force`         | `remove` | Remove even with uncommitted or untracked changes           |
| `-d`, `--delete-branch` | `remove` | Also delete the branch                                      |
| `--keep-branch`         | `remove` | Keep the branch (don't prompt)                              |

**Interactive vs. unattended.** At a terminal `wt` prompts for missing values — the worktree name, which worktree to act on (type-to-filter picker: type to narrow, ↑/↓, Enter; Ctrl+C cancels), whether to reuse an existing branch, whether to force a dirty removal, whether to delete the branch. Pass everything as flags to run unattended; with no terminal (scripts, CI, agents) a missing required value errors instead of blocking. Cancelling a prompt is not an error — it returns `{"aborted":true,"reason":"..."}` with exit code 0.

**Branch behavior.** `wt add <name>` creates a branch named after the worktree off the current `HEAD`. If that branch already exists, `wt` offers to reuse or recreate it (or, non-interactively, tells you to pass `-b`); if another worktree has it checked out, that's an error. Use `-b <branch>` to check out an existing branch instead.

**Renaming.** `wt mv <new>` renames the worktree you're currently in; `wt mv <old> <new>` renames another; `wt mv` picks from a list and prompts for the new name. It moves the directory _and_ renames the branch — but only when the branch still matches the worktree name (as `wt add` leaves it). If they've diverged, the directory moves and the branch is left alone unless you pass `--branch <b>`; `-B` never touches it; a detached worktree moves with HEAD untouched. Uncommitted changes ride along. All checks run before anything moves, so a rejected rename leaves nothing half-applied; if the branch rename fails _after_ the move it warns and reports `branchRenamed: false`. Renaming the worktree a shell is sitting in strands that shell on a dead path — `wt` prints the `cd` (keeping your subdirectory), and the `wtm` helper below runs it for you. Other terminals in the old path must `cd` themselves.

`wt` refuses to rename or remove the **main** worktree.

**Migrating from the old config-based CLI.** `wt.yaml` is ignored. Map
`worktrees_dir` to `WT_DIR`, move add/clean commands into repo-root
`init.wt.sh`/`clean.wt.sh`, replace file/template rules with shell commands in
`init.wt.sh`, derive ports and resource names from `WT_NAME`, and use
`WT_AUTO_UPDATE=1` for automatic updates. `wt init`, `wt open`, generated port
offsets/unique names, and the global `--repo` selector no longer exist.

## Repo layout

`wt` is most commonly used with a **bare repo**: every checkout — including `main` — is a worktree under `.worktrees/`. Nothing is checked out at the root, so it stays a stable home for git internals, local-only files, and the hooks.

```
myrepo/                  # the bare repo  ← this is $WT_ROOT
  HEAD, objects/, ...    # git internals (bare repo contents)
  init.wt.sh             # runs after `wt add`     (in the new worktree)
  clean.wt.sh            # runs before `wt remove` (in the worktree being removed)
  rename.wt.sh           # runs after `wt mv`      (in the worktree at its new path)
  .env                   # local-only files live at the root, next to the hooks
  .worktrees/
    main/                # the main checkout is just another worktree
    feature-x/           # ← a new `wt add feature-x` lands here ($WT_PATH)
    bugfix-y/
```

Set this up once. A plain `git clone --bare` only records the remote URL — it sets **no fetch refspec**, so you get no `origin/*` tracking branches and `git fetch` won't update them. Add the refspec to make the bare repo behave like a normal one:

```sh
git clone --bare git@github.com:you/myrepo.git myrepo
cd myrepo
git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git fetch origin          # now origin/* tracking branches exist

wt add main -b main       # check out the default branch as the first worktree
# drop your .env, init.wt.sh, etc. at the repo root, then:
wt add feature-x          # → .worktrees/feature-x
```

`wt` also works in a **regular (non-bare) repo** — there `$WT_ROOT` is the main worktree's top level and added worktrees go in `<repo>/.worktrees/<name>` beside your code (add `.worktrees/` to `.gitignore`). The bare layout is preferred: every branch is symmetric, with no privileged checkout mixed into the worktrees dir.

Worktrees default to `<root>/.worktrees/<name>`; override with `WT_DIR`:

```sh
WT_DIR=~/wt/myrepo wt add feature-x
```

A worktree's name is its path under that directory, so nested names work: `wt add feat/voice-input` → `.worktrees/feat/voice-input` on branch `feat/voice-input`.

`WT_AUTO_UPDATE=1` lets `wt` update itself before running a command.

## Hooks: where they go and what to put in them

Optional `bash` scripts at the **repo root** run automatically when present — _all_ per-worktree behavior lives here.

| Script         | Runs                     | In which directory               |
| -------------- | ------------------------ | -------------------------------- |
| `init.wt.sh`   | right after `wt add`     | the new worktree                 |
| `clean.wt.sh`  | right before `wt remove` | the worktree being removed       |
| `rename.wt.sh` | right after `wt mv`      | the worktree at its **new** path |

Each receives these environment variables:

| Var         | Value                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `WT_NAME`   | the worktree name                                                                                                             |
| `WT_PATH`   | absolute path to the worktree                                                                                                 |
| `WT_ROOT`   | absolute path to the repo root — the **bare repo** itself in a bare setup, or the main worktree's top level in a regular repo |
| `WT_BRANCH` | the worktree's branch (or `(detached)`)                                                                                       |

A failing hook only prints a warning — it never aborts the add, rename or remove.

### `init.wt.sh` — bootstrapping a new worktree

The hook you'll write most. A fresh worktree has the tracked files but **none of the local, git-ignored state** that makes the repo runnable — `init.wt.sh` rebuilds it. Typical jobs:

- **Copy local-only files** not in git — `.env`, credentials, certs.
- **Install dependencies** — `pnpm install`, `uv sync`, `npm ci`.
- **Restore caches / artifacts** — copy `node_modules`, `.venv`, or submodules from the `main` checkout instead of re-downloading.
- **Start per-worktree services** on isolated ports/names so worktrees don't collide.

Two things to know about paths:

- **The script's working directory is the new worktree** (`$WT_PATH`), so `.` refers to it — `cp "$WT_ROOT/.env" .` copies _into_ the worktree. You rarely need `$WT_PATH` explicitly.
- **`$WT_ROOT` is the repo root** — in a bare setup that's the bare repo (git internals), _not_ a checkout. Keep local-only files there. Things that only exist in a checkout (built `node_modules`, submodule trees) come from the main worktree at `$WT_ROOT/.worktrees/main`.

```sh
#!/usr/bin/env bash
set -euo pipefail
# cwd is the new worktree; $WT_ROOT is the repo root (bare repo).
MAIN="$WT_ROOT/.worktrees/main"

cp "$WT_ROOT/.env" .              # local-only files kept at the root
cp -Rc "$MAIN/node_modules" .     # restore a cache (APFS: -Rc is instant CoW)
pnpm install                      # install deps against this worktree
docker run -d --name "myapp-$WT_NAME" -p 5432 postgres:15   # isolated service
```

### `clean.wt.sh` — tearing it down

Runs in the worktree just before removal. Tear down whatever `init.wt.sh` started, keyed off `WT_NAME` so you only touch this worktree's resources:

```sh
#!/usr/bin/env bash
docker rm -f "myapp-$WT_NAME" 2>/dev/null || true
```

### `rename.wt.sh` — following a rename

Runs in the worktree at its new path after `wt mv`, with `WT_OLD_NAME`, `WT_OLD_PATH` and `WT_OLD_BRANCH` on top of the usual vars. Anything `init.wt.sh` named after the worktree — containers, volumes, generated config holding absolute paths — is now stale, and this is where you fix it:

```sh
#!/usr/bin/env bash
docker rename "myapp-$WT_OLD_NAME" "myapp-$WT_NAME" 2>/dev/null || true
sed -i '' "s|$WT_OLD_PATH|$WT_PATH|g" .env
```

## Scripting with JSON

With `-j`, **stdout is pure JSON** and prompts/progress go to stderr — so `wt add -j | jq` can still prompt for a name while piping clean JSON onward.

```sh
wt list -j | jq -r '.worktrees[] | select(.main|not) | .name'
cd "$(wt add feature-x -j | jq -r .path)"
wt mv feature-x feature-y -j | jq -r .path
wt remove feature-x -j -d | jq .
```

Result shapes:

```jsonc
// list
{"worktrees":[{"name","path","branch","head","main","locked"}, ...]}
// add
{"name","path","branch","created":true,"hookRan":true|false}
// view
{"name","path","branch","head","main","locked","dirty","ahead","behind"}
// mv
{"name","path","branch","oldName","oldPath","oldBranch","moved":true,"branchRenamed":true|false}
// remove
{"name","path","removed":true,"branchDeleted":true|false,"hookRan":true|false}
// cancelled at a prompt (exit code 0)
{"aborted":true,"reason":"User cancelled"}
```

Errors are `{"error":true,"message":"..."}` with exit code 1, carrying git's own stderr when git is what failed. That JSON lands on **stdout**, so anything capturing output must re-surface `.message` on stderr or failures look silent.

`view`'s `ahead`/`behind` are `null` when the branch has no upstream. `branch` is the string `(detached)` for a detached worktree everywhere it appears. `head` is the full commit hash in `list` and abbreviated to 12 characters in `view`; git accepts either wherever a commit is expected.

## Shell helpers (`wt.sh`)

`add`, `view` and `mv` report the worktree's absolute `.path`, but only a shell can change its own directory. Download the released `wt.sh` wrappers and source them from `~/.zshrc` or `~/.bashrc` (zsh and bash, needs `jq`):

```sh
mkdir -p ~/.local/share/wt
curl -fsSL https://loxel.bizimind.io/wt/wt.sh -o ~/.local/share/wt/wt.sh
source ~/.local/share/wt/wt.sh
```

| Helper          | Does                                                                                    |
| --------------- | --------------------------------------------------------------------------------------- |
| `wta [name]`    | `wt add`, then cd into the new worktree                                                 |
| `wtv [name]`    | `wt view`, then cd into it (picker when no name)                                        |
| `wtr [name]`    | `wt remove`                                                                             |
| `wtm [old] new` | `wt mv`, then follow the worktree to its new path, keeping the subdirectory you were in |

`WT_BIN` (set before sourcing) points the helpers at a different binary — a locally built `dist/wt`, say. `wtm` exports `WT_SHELL_WRAPPER=1`, which tells the CLI to skip its own "run this cd" message because the wrapper does the `cd` itself.

Prefer editing `wt.sh` in the repo over pasting wrappers into a dotfile — it's versioned alongside the `-j` shapes it parses.

## Library API

`@bizimind/wt/lib` exposes the same operations programmatically, split into `plan*` (inspect, no mutations) and `execute*`, so a UI can resolve decisions before anything changes: `planAdd`/`executeAdd`, `planMove`/`executeMove`, `planRemove`/`executeRemove`, plus `listManagedWorktrees`, `currentManagedWorktree` and `resolveWorktreesDir`.
