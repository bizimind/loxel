# wt - Git Worktree Manager

A CLI for managing git worktrees. Built for parallel development workflows where you need multiple isolated checkouts of one repository running simultaneously. **No config file, no state file**: git itself is the database (`git worktree list`), and everything a worktree needs beyond the checkout lives in three optional shell scripts at the repo root.

## Table of Contents

- [Why wt?](#why-wt)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Where Worktrees Live](#where-worktrees-live)
- [Hooks](#hooks)
- [Renaming](#renaming)
- [CLI Reference](#cli-reference)
- [JSON Mode](#json-mode)
- [Shell Integration](#shell-integration)
- [Real-World Examples](#real-world-examples)
- [Library API](#library-api)
- [Upgrading from the Config-Based CLI](#upgrading-from-the-config-based-cli)
- [Development](#development)
- [Requirements](#requirements)
- [Roadmap](#roadmap)

---

## Why wt?

Git worktrees let you check out multiple branches simultaneously in separate directories. This is powerful for:

- Working on multiple features in parallel
- Running multiple AI coding agents (Claude Code, Cursor, etc.) simultaneously
- Quick context switching without stashing
- Testing changes against different branches

But raw `git worktree` commands are verbose and don't handle the real challenges:

- **Environment setup**: Copying secrets, installing dependencies, starting services
- **Resource naming**: Docker containers, databases and ports need to be unique per worktree
- **Renames**: Moving a worktree should move its branch, and fix up anything named after it
- **Cleanup**: Stopping containers and removing resources when done

`wt` solves this with three plain shell hooks and nothing else to configure. Git is the only source of truth, so there is nothing to initialize and nothing to keep in sync.

---

## Installation

Download the released binary for your platform (listed in [the manifest](https://loxel.bizimind.io/wt/manifest.json)) and the shell helpers:

```bash
mkdir -p ~/.local/bin ~/.local/share/wt
curl -fsSL https://loxel.bizimind.io/wt/darwin-arm64/wt -o ~/.local/bin/wt && chmod +x ~/.local/bin/wt
curl -fsSL https://loxel.bizimind.io/wt/wt.sh -o ~/.local/share/wt/wt.sh
wt version
```

Or build from the loxel monorepo:

```bash
pnpm install
pnpm -C packages/wt run build

# Install to your PATH and sign (required on macOS or the binary gets SIGKILL'd)
cp packages/wt/dist/wt ~/.local/bin/
codesign -s - ~/.local/bin/wt

wt version
```

`wt update` upgrades the binary in place; set `WT_AUTO_UPDATE=1` to have it check before every command.

---

## Quick Start

### 1. Set up a bare repository

`wt` is most commonly used with a **bare repo**: every checkout, including `main`, is a worktree under `.worktrees/`, so the root stays a stable home for git internals, local-only files and the hooks. A plain `git clone --bare` records no fetch refspec, so add one to get `origin/*` tracking branches:

```bash
git clone --bare git@github.com:myorg/myproject.git myproject
cd myproject
git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git fetch origin

wt add main -b main        # check out the default branch as the first worktree
```

`wt` also works in a regular (non-bare) repo: there the repo root is the main worktree's top level and added worktrees go in `<repo>/.worktrees/<name>` beside your code. wt adds that directory to `.git/info/exclude` on first use so the main checkout's status stays clean without a committed `.gitignore` entry.

### 2. Create worktrees

```bash
wt add feature-auth        # creates .worktrees/feature-auth on branch feature-auth
wt add feature-payments
wt add bugfix-123

wt list                    # see all worktrees
```

### 3. Work in parallel

Each worktree is a full checkout on its own branch. Run one agent or dev server per worktree.

### 4. Clean up

```bash
wt remove feature-auth     # removes the worktree, offers to delete the branch
```

### 5. Automate setup with a hook (optional)

A fresh worktree has the tracked files but none of the local, git-ignored state that makes the repo runnable. If you put a script named `init.wt.sh` at the repo root, `wt add` runs it inside every new worktree. The contents are entirely yours. As an example, this one copies a local env file, installs dependencies and starts a database container named after the worktree:

```bash
#!/usr/bin/env bash
set -euo pipefail

cp "$WT_ROOT/.env.local" .
pnpm install
docker run -d --name "myapp-$WT_NAME" -p 0:5432 postgres:15
```

A matching `clean.wt.sh` would remove that container before `wt remove` deletes the checkout. See [Hooks](#hooks) for the full set of hooks and the variables they receive, and [Real-World Examples](#real-world-examples) for complete hook sets.

---

## Where Worktrees Live

New worktrees are created at `<repoRoot>/.worktrees/<name>`. The repo root is the main worktree's top level, or the git directory for a bare repo. Override the location with `WT_DIR`:

```bash
WT_DIR=~/wt/myrepo wt add feature-x
```

A worktree's name is its path under the worktrees directory, so nested names work: `wt add feat/voice-input` creates `.worktrees/feat/voice-input` on branch `feat/voice-input`.

`wt add <name>` creates a branch named after the worktree from the current `HEAD`. Pass `-b <branch>` to check out an existing branch instead. If a branch named after the worktree already exists, wt offers to reuse it or recreate it, unless another worktree has it checked out, which is an error.

If a registered worktree's checkout directory disappears outside `wt`, it remains listable and removable. Git-dependent inspection reports no dirty changes or upstream divergence for that unavailable checkout, and a cleanup hook that cannot start there is skipped with a warning.

### Environment

| Var              | Effect                                                        |
| ---------------- | ------------------------------------------------------------- |
| `WT_DIR`         | Where worktrees are created (default `<repoRoot>/.worktrees`) |
| `WT_AUTO_UPDATE` | Set to `1` to let wt update itself before running a command   |

---

## Hooks

Optional scripts at the **repo root**, run with `bash` if present:

| Script         | When                     | Runs in                          |
| -------------- | ------------------------ | -------------------------------- |
| `init.wt.sh`   | right after `wt add`     | the new worktree                 |
| `clean.wt.sh`  | right before `wt remove` | the worktree being removed       |
| `rename.wt.sh` | right after `wt mv`      | the worktree at its **new** path |

Every hook gets:

| Var         | Value                                  |
| ----------- | -------------------------------------- |
| `WT_NAME`   | the worktree name                      |
| `WT_PATH`   | absolute path to the worktree          |
| `WT_ROOT`   | absolute path to the repo root         |
| `WT_BRANCH` | the worktree's branch, or `(detached)` |

`rename.wt.sh` additionally gets `WT_OLD_NAME`, `WT_OLD_PATH` and `WT_OLD_BRANCH`, so it can fix up anything `init.wt.sh` named after the old worktree.

Two things to know about paths. The script's working directory is the worktree (`$WT_PATH`), so `.` refers to it and `cp "$WT_ROOT/.env" .` copies into the worktree. And `$WT_ROOT` is the repo root, which in a bare setup is the bare repo itself, not a checkout: keep local-only files there, and take things that only exist in a checkout (built `node_modules`, submodule trees) from the main worktree at `$WT_ROOT/.worktrees/main`.

File copying, dependency installs, container setup, `.env` generation, port assignment: all of it lives in these scripts. wt has no opinion about any of it. Hook output streams to the terminal as it is produced. A failing hook prints a warning; it never aborts the add, rename or remove.

### Example: copying local resources

This `init.wt.sh` shows the most common job: mirroring untracked files (env files, credentials, certs) from a directory at the repo root into the new worktree. The directory name is a convention, not something wt knows about:

```bash
#!/usr/bin/env bash
set -euo pipefail
cp -R "$WT_ROOT/.wt-local-res/." .
```

### Example: per-worktree ports and names

wt assigns no ports and generates no names; hooks derive them from `WT_NAME`. This `init.wt.sh` shows one way to turn the name into a stable numeric offset for ports and a safe database name:

```bash
#!/usr/bin/env bash
set -euo pipefail
# init.wt.sh
OFFSET=$(( $(cksum <<<"$WT_NAME" | cut -d' ' -f1) % 100 * 10 ))
echo "PORT=$((3000 + OFFSET))" >> .env.local
echo "DATABASE_URL=postgres://localhost:$((5432 + OFFSET))/myapp_${WT_NAME//\//_}" >> .env.local
```

---

## Renaming

`wt mv` renames the worktree's directory (`git worktree move`) and its branch (`git branch -m`) together:

```bash
wt mv new-name              # rename the worktree you're currently in
wt mv old-name new-name     # rename another one
wt mv                       # pick from a list, then type the new name
```

The branch follows the worktree name only when the two are already in sync, which they are for anything made by `wt add`. When they have diverged (an existing branch adopted via `add -b`), `mv` moves the directory and leaves the branch alone, saying so; pass `--branch <b>` to rename it anyway, or `-B` to never touch it. A detached worktree moves with its HEAD untouched. Uncommitted changes ride along, so there is no dirty-tree prompt.

Every check runs before anything moves (the new name, the destination, the target branch), so a rejected rename leaves no half-applied state. The move is the only irreversible step: if the branch rename fails afterwards it warns and reports `branchRenamed: false` rather than failing.

Renaming the worktree your shell is sitting in leaves that shell on a path that no longer exists. `wt mv` prints the `cd` you need (keeping the subdirectory you were in); the `wtm` helper from [Shell Integration](#shell-integration) does it for you. Other terminals and processes in the old path have to move themselves.

---

## CLI Reference

Run interactively and wt prompts for the common decisions: the worktree name, what to do when the branch already exists, which worktree to act on, whether to force a dirty removal, and whether to delete the branch too. Pass everything as flags and it runs unattended; without a terminal a missing required value errors instead of blocking, and destructive commands never auto-select a target.

| Flag                    | Commands | Meaning                                                    |
| ----------------------- | -------- | ---------------------------------------------------------- |
| `-j`, `--json`          | all      | JSON result on stdout; progress and prompts stay on stderr |
| `-b`, `--branch <b>`    | `add`    | Check out an existing branch instead of creating one       |
| `--branch <b>`          | `mv`     | Rename the branch to `<b>` instead of the new name         |
| `-B`, `--keep-branch`   | `mv`     | Rename the directory only, leaving the branch alone        |
| `-f`, `--force`         | `mv`     | Move a locked worktree                                     |
| `-f`, `--force`         | `remove` | Remove even with uncommitted or untracked changes          |
| `-d`, `--delete-branch` | `remove` | Also delete the worktree's branch; an unmerged one is kept |
| `-D`, `--force-branch`  | `remove` | Delete the branch even if unmerged (implies `-d`)          |
| `--keep-branch`         | `remove` | Keep the branch (no prompt)                                |

### `wt list` (alias: `ls`)

List every worktree git knows about, marking the main worktree.

```bash
wt list
```

```
Name          Branch        Path
------------  ------------  ----------------------------------------
main          main          /path/to/myproject/.worktrees/main
feature-auth  feature-auth  /path/to/myproject/.worktrees/feature-auth
```

### `wt add [name]` (alias: `create`)

Create a worktree at `<worktreesDir>/<name>`, then run `init.wt.sh`. Prompts for the name when omitted.

```bash
wt add feature-auth                    # new branch feature-auth from HEAD
wt add feature-auth -b existing-branch # check out an existing branch instead
```

### `wt view [name]`

Show one worktree's branch, head, path, lock state, dirty file count and upstream divergence. Picks from a list when the name is omitted. The dirty count includes changes inside initialized submodules and is `null` when the status cannot be read.

### `wt mv [old] <new>` (aliases: `rename`, `move`)

Rename a worktree and its branch, then run `rename.wt.sh`. See [Renaming](#renaming).

### `wt remove [name]` (aliases: `rm`, `delete`)

Run `clean.wt.sh`, then remove the worktree. Keeps the branch unless asked to delete it, and `-d` refuses to delete a branch with unmerged commits (it warns and reports `branchDeleted: false`); use `-D` to delete it anyway. Empty parent directories left behind by a nested name such as `feat/foo` are removed so the name can be reused.

Clean worktrees with initialized submodules can be removed without `--force`. Changes inside submodules, nested ones included, are checked explicitly, even when `submodule.<name>.ignore=all` is configured; those removals still require `--force`, as does a submodule holding commits that no remote has, since a linked worktree's submodule objects live under its own git directory and are deleted with it. The older-Git compatibility fallback removes only the selected worktree's metadata; it does not prune other unavailable worktrees from the repository.

```bash
wt remove feature-auth                 # prompts about the branch when interactive
wt remove feature-auth -d              # also delete the branch, if merged
wt remove feature-auth -D              # delete the branch even if unmerged
wt remove feature-auth --force         # remove despite uncommitted changes
```

### `wt version`, `wt update`

Print the installed version, or update the binary in place.

---

## JSON Mode

With `-j`, stdout carries only JSON. Progress, hook output and prompts go to stderr, so `wt add -j | jq` works while still being interactive.

```jsonc
// list
{"worktrees":[{"name","path","branch","head","main","locked"}, ...]}
// add
{"name","path","branch","created":true,"hookRan":false}
// mv
{"name","path","branch","oldName","oldPath","oldBranch","moved":true,"branchRenamed":true}
// view — `head` is abbreviated to 12 chars here, full in `list`; `ahead`/`behind` are null without an upstream
{"name","path","branch","head","main","locked","dirty","ahead","behind"}
// remove
{"name","path","removed":true,"branchDeleted":false,"hookRan":true}
// cancelled at a prompt, via Cancel or Ctrl+C (exit code 0)
{"aborted":true,"reason":"User cancelled"}
```

Errors come back as `{"error":true,"message":"..."}` with exit code 1, and carry git's own stderr when git is what failed.

```bash
wt list -j | jq -r '.worktrees[] | select(.main|not) | .name'
cd "$(wt add feature-x -j | jq -r .path)"
cd "$(wt mv feature-x feature-y -j | jq -r .path)"
```

---

## Shell Integration

`add`, `view` and `mv` report the worktree's absolute `.path`, but only a shell can change its own directory. `wt.sh` provides wrappers that do it (zsh and bash, needs `jq`). Source it from `~/.zshrc` or `~/.bashrc` after downloading it as shown in [Installation](#installation):

```bash
source ~/.local/share/wt/wt.sh
```

| Helper          | Does                                                                         |
| --------------- | ---------------------------------------------------------------------------- |
| `wta [name]`    | `wt add`, then cd into the new worktree                                      |
| `wtv [name]`    | `wt view`, then cd into it (picker when no name)                             |
| `wtr [name]`    | `wt remove`                                                                  |
| `wtm [old] new` | `wt mv`, then follow the worktree to its new path, keeping your subdirectory |

They call `wt` on PATH; set `WT_BIN` before sourcing to point somewhere else (a locally built `dist/wt`, say). They live beside the CLI so the wrappers and the `-j` shapes they parse stay versioned together.

---

## Real-World Examples

Each of these is an example set of hook scripts for one kind of project. None of it is required by wt; copy what fits and change the rest.

### Full-stack web app (Node.js + PostgreSQL + Redis)

```bash
# init.wt.sh
#!/usr/bin/env bash
set -euo pipefail
NAME=${WT_NAME//\//-}
OFFSET=$(( $(cksum <<<"$WT_NAME" | cut -d' ' -f1) % 100 * 10 ))

docker run -d --name "myapp-pg-$NAME" -e POSTGRES_PASSWORD=dev -p $((5432 + OFFSET)):5432 postgres:15
docker run -d --name "myapp-redis-$NAME" -p $((6379 + OFFSET)):6379 redis:7-alpine

cat >> .env.local <<EOF
DATABASE_URL=postgres://postgres:dev@localhost:$((5432 + OFFSET))/postgres
REDIS_URL=redis://localhost:$((6379 + OFFSET))
API_PORT=$((3000 + OFFSET))
EOF

pnpm install
pnpm db:migrate
```

```bash
# clean.wt.sh
#!/usr/bin/env bash
NAME=${WT_NAME//\//-}
docker rm -f "myapp-pg-$NAME" "myapp-redis-$NAME" 2>/dev/null || true
```

```bash
# rename.wt.sh
#!/usr/bin/env bash
OLD=${WT_OLD_NAME//\//-}; NEW=${WT_NAME//\//-}
docker rename "myapp-pg-$OLD" "myapp-pg-$NEW" 2>/dev/null || true
docker rename "myapp-redis-$OLD" "myapp-redis-$NEW" 2>/dev/null || true
```

### Monorepo with cached dependencies

Restore `node_modules` from the main checkout instead of re-downloading. On APFS, `cp -c` clones instantly with copy-on-write:

```bash
# init.wt.sh
#!/usr/bin/env bash
set -euo pipefail
MAIN="$WT_ROOT/.worktrees/main"
cp -Rc "$MAIN/node_modules" . 2>/dev/null || true
cp "$WT_ROOT/.env" .
pnpm install
```

### AI agent parallel development

Each agent gets its own worktree, branch, dependencies and services from one shared repo:

```bash
wta feature-auth            # creates the worktree, runs init.wt.sh, cds into it
claude                      # start an agent here

# in another terminal
wta feature-payments
claude
```

When the work lands, `wtr feature-auth -d` tears down the services via `clean.wt.sh`, removes the worktree and deletes the branch.

### Claude Code settings sharing

Share `.claude/settings.local.json` across worktrees and merge permissions back on removal:

```bash
# init.wt.sh
#!/usr/bin/env bash
SRC="$WT_ROOT/.claude/settings.local.json"
[ -f "$SRC" ] && mkdir -p .claude && cp "$SRC" .claude/settings.local.json
```

```bash
# clean.wt.sh
#!/usr/bin/env bash
SRC=".claude/settings.local.json"
DST="$WT_ROOT/.claude/settings.local.json"
[ -f "$SRC" ] || exit 0
mkdir -p "$WT_ROOT/.claude"
if [ -f "$DST" ]; then
  jq -s '
    .[0] as $dst | .[1] as $src |
    ($dst // {}) * ($src // {}) * {
      permissions: {
        allow: ([$dst.permissions.allow // [], $src.permissions.allow // []] | add | unique | sort),
        deny: ([$dst.permissions.deny // [], $src.permissions.deny // []] | add | unique | sort)
      }
    }
    | .permissions |= with_entries(select(.value | length > 0))
  ' "$DST" "$SRC" > "$DST.tmp" && mv "$DST.tmp" "$DST"
else
  cp "$SRC" "$DST"
fi
```

New worktrees inherit your accumulated Claude Code permissions, and permissions granted during development are preserved when the worktree is removed.

---

## Library API

`@bizimind/wt/lib` exposes the same operations for programmatic use, with the plan/execute split that lets a UI resolve decisions before mutating anything:

```ts
import {
  planAdd,
  executeAdd,
  planMove,
  executeMove,
  planRemove,
  executeRemove,
  forceReason,
} from "@bizimind/wt/lib";

const plan = await planAdd({ name: "feat/foo", repoPath });
// plan.branchConflict?.kind === "used-by-worktree" | "exists"

const added = await executeAdd(
  { name: "feat/foo", repoPath, branchResolution: "use-existing" },
  { log: console.log, warn: console.warn },
);

const move = await planMove({ oldName: "feat/foo", name: "feat/bar", repoPath });
// move.newBranch === "feat/bar", or null with move.branchSkipReason set
const moved = await executeMove({ oldName: "feat/foo", name: "feat/bar", repoPath });

const removal = await planRemove({ name: "feat/bar", repoPath });
// removal.dirty, or removal.localOnlySubmodules non-empty, means git (or wt on
// its behalf) refuses without force; forceReason() phrases that for a prompt.
if (!forceReason("feat/bar", removal)) {
  await executeRemove({ name: "feat/bar", repoPath, deleteBranch: true, force: false });
}
```

Also exported: `forceReason`, `lockedMessage`, `resolveWorktreesDir`, `listManagedWorktrees`, `currentManagedWorktree`, `getWorktreeName`, `detectRepoType`, `hasUncommittedChanges`, `getCurrentBranch`, `initBareRepo`, `transformToBare`, `ensureWorktreesDir`, the hook filename constants, and the `ProgressHandler` type.

---

## Upgrading from the Config-Based CLI

`wt.yaml`, generated state files, `wt init`, `wt open`, `wt completions`, the global `--repo` selector, automatic port offsets, and generated unique names are no longer supported. Existing `wt.yaml` files are ignored, so migrate their behavior before relying on this version:

- Replace `worktrees_dir` with the `WT_DIR` environment variable when the default `.worktrees` directory is not suitable.
- Move `hooks.add.run` into repo-root `init.wt.sh`, and `hooks.clean.run` into `clean.wt.sh`.
- Replace `hooks.add.files` and templates with ordinary shell copy/generation commands in `init.wt.sh`; the source directory remains your choice.
- Derive ports and resource names from `WT_NAME` inside the hook scripts (see [Real-World Examples](#real-world-examples)).
- Replace `automatic_updates: true` with `WT_AUTO_UPDATE=1`.
- Use the shell helpers instead of `wt open` when you want the calling shell to change directory.

Remove the obsolete `wt.yaml` after migrating. Existing git worktrees remain registered in git and are not modified by the upgrade.

---

## Development

```bash
bun src/cli.ts add feature-x      # run from source
pnpm -C packages/wt run test
pnpm -C packages/wt run typecheck
pnpm -C packages/wt run build     # standalone binary at dist/wt
```

The tests drive real git against temporary repositories created by `src/test-repo.ts`. Because wt removes worktrees and runs hooks, `test/safety-preload.ts` sandboxes every run. It is loaded by this package's `bunfig.toml`, so always run the tests with the package as cwd (`pnpm -C packages/wt run test`, or `bun test --cwd packages/wt <file>`); a `bun test packages/wt/...` from the repo root would skip it. The sandbox: `GIT_CEILING_DIRECTORIES` and a guard around wt's git helpers keep git away from this checkout, ambient `GIT_*`, `WT_*`, shell-startup and temp-dir variables are cleared, and `process.chdir`/`process.exit` are blocked. Always build fixtures with `createTestRepo()`; never point a test at a real repository.

---

## Requirements

- **Git** 2.31+ (`git worktree move` and `rev-parse --path-format`)
- **bash** and **jq** for the hooks and shell helpers
- **Bun** 1.0+ only when running or building from source

---

## Roadmap

Future features under consideration:

- [ ] **Shell environment auto-population** - Auto-generate `.envrc` with per-worktree vars for direnv
- [ ] **Version management** - Different node/bun/python versions per worktree (mise/asdf integration)
- [ ] **Session management** - tmux integration for persistent processes
- [ ] **Status dashboard** - View all worktrees' git status at a glance
- [ ] **Shell completions** - Tab completion for commands and worktree names

---

## License

[FSL-1.1-ALv2](../../LICENSE) — source available for non-competing use; converts to Apache 2.0 after 2 years.
