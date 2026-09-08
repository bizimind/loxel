# wt — configless git worktree manager

A small CLI for juggling git worktrees. **No config file, no state file**: git
itself is the database (`git worktree list`), and everything a worktree needs
beyond the checkout lives in three optional shell scripts at the repo root.

- **Configless.** Nothing to initialize, nothing to keep in sync.
- **Hooks are plain shell scripts** wt runs automatically when present.
- **Bare and non-bare repos** both work.
- **JSON output** (`-j`) on stdout, prompts and progress on stderr.

## Upgrading from the config-based CLI

`wt.yaml`, generated state files, `wt init`, `wt open`, the global `--repo`
selector, automatic port offsets, and generated unique names are no longer
supported. Existing `wt.yaml` files are ignored, so migrate their behavior
before relying on this version:

- Replace `worktrees_dir` with the `WT_DIR` environment variable when the
  default `.worktrees` directory is not suitable.
- Move `hooks.add.run` into repo-root `init.wt.sh`, and `hooks.clean.run` into
  `clean.wt.sh`.
- Replace `hooks.add.files` and templates with ordinary shell copy/generation
  commands in `init.wt.sh`; the source directory remains your choice.
- Derive ports and resource names from `WT_NAME` inside the hook scripts.
- Replace `automatic_updates: true` with `WT_AUTO_UPDATE=1`.
- Use the shell helpers below instead of `wt open` when you want the calling
  shell to change directory.

Remove the obsolete `wt.yaml` after migrating. Existing Git worktrees remain
registered in Git and are not modified by the upgrade.

## Commands

```sh
wt add [name]      # create a worktree, then run init.wt.sh   (alias: create)
wt list            # list worktrees                          (alias: ls)
wt view [name]     # show one worktree's details
wt mv [old] <new>  # rename a worktree and its branch  (aliases: rename, move)
wt remove [name]   # run clean.wt.sh, then remove            (aliases: rm, delete)
wt version         # print the installed version
wt update          # update the binary in place
```

Run interactively and wt prompts for the common decisions: the worktree name,
what to do when the branch already exists, which worktree to act on, whether to
force a dirty removal, and whether to delete the branch too. Pass everything as
flags and it runs unattended — nothing prompts without a terminal.

| Flag                    | Commands | Meaning                                                    |
| ----------------------- | -------- | ---------------------------------------------------------- |
| `-j`, `--json`          | all      | JSON result on stdout; progress and prompts stay on stderr |
| `-b`, `--branch <b>`    | `add`    | Check out an existing branch instead of creating one       |
| `--branch <b>`          | `mv`     | Rename the branch to `<b>` instead of the new name         |
| `-B`, `--keep-branch`   | `mv`     | Rename the directory only, leaving the branch alone        |
| `-f`, `--force`         | `mv`     | Move a locked worktree                                     |
| `-f`, `--force`         | `remove` | Remove even with uncommitted or untracked changes          |
| `-d`, `--delete-branch` | `remove` | Also delete the worktree's branch                          |
| `--keep-branch`         | `remove` | Keep the branch (no prompt)                                |

## Where worktrees live

New worktrees are created at `<repoRoot>/.worktrees/<name>`. The repo root is
the main worktree's top level, or the git directory for a bare repo. Override
the location with `WT_DIR`:

```sh
WT_DIR=~/wt/myrepo wt add feature-x
```

A worktree's name is its path under the worktrees directory, so nested names
work: `wt add feat/voice-input` creates `.worktrees/feat/voice-input` on branch
`feat/voice-input`.

`wt add <name>` creates a branch named after the worktree from the current
`HEAD`. Pass `-b <branch>` to check out an existing branch instead. If a branch
named after the worktree already exists, wt offers to reuse it or recreate it —
unless another worktree has it checked out, which is an error.

## Renaming

`wt mv` renames the worktree's directory (`git worktree move`) and its branch
(`git branch -m`) together:

```sh
wt mv new-name              # rename the worktree you're currently in
wt mv old-name new-name     # rename another one
wt mv                       # pick from a list, then type the new name
```

The branch follows the worktree name only when the two are already in sync —
which they are for anything made by `wt add`. When they have diverged (an
existing branch adopted via `add -b`), `mv` moves the directory and leaves the
branch alone, saying so; pass `--branch <b>` to rename it anyway, or `-B` to
never touch it. A detached worktree moves with its HEAD untouched. Uncommitted
changes ride along, so there is no dirty-tree prompt.

Every check runs before anything moves — the new name, the destination, the
target branch — so a rejected rename leaves no half-applied state. The move is
the only irreversible step: if the branch rename fails afterwards it warns and
reports `branchRenamed: false` rather than failing.

Renaming the worktree your shell is sitting in leaves that shell on a path that
no longer exists. `wt mv` prints the `cd` you need (keeping the subdirectory you
were in); the `wtm` helper from [Shell integration](#shell-integration) does it
for you. Other terminals and processes in the old path have to move themselves —
nothing can reach them from here.

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

`rename.wt.sh` additionally gets `WT_OLD_NAME`, `WT_OLD_PATH` and
`WT_OLD_BRANCH`, so it can fix up anything `init.wt.sh` named after the old
worktree — containers, volumes, generated config holding absolute paths:

```sh
# rename.wt.sh
#!/usr/bin/env bash
docker rename "myapp-$WT_OLD_NAME" "myapp-$WT_NAME" 2>/dev/null || true
sed -i '' "s|$WT_OLD_PATH|$WT_PATH|g" .env.local
```

File copying, dependency installs, container setup, `.env` generation, port
assignment — all of it lives in these scripts. wt has no opinion about any of
it.

```sh
# init.wt.sh
#!/usr/bin/env bash
set -euo pipefail

cp "$WT_ROOT/.env.local" .          # local-only files the new worktree needs
pnpm install

# derive per-worktree resources from the name
docker run -d --name "myapp-$WT_NAME" -p 0:5432 postgres:15
```

```sh
# clean.wt.sh
#!/usr/bin/env bash
docker rm -f "myapp-$WT_NAME" 2>/dev/null || true
```

A failing hook prints a warning; it never aborts the add, rename or remove.

## JSON mode

With `-j`, stdout carries only JSON — progress, hook output and prompts go to
stderr, so `wt add -j | jq` works while still being interactive.

```jsonc
// list
{"worktrees":[{"name","path","branch","head","main","locked"}, ...]}
// add
{"name","path","branch","created":true,"hookRan":false}
// mv
{"name","path","branch","oldName","oldPath","oldBranch","moved":true,"branchRenamed":true}
// view — `head` is abbreviated to 12 chars here, full in `list`;
// `ahead`/`behind` are null when the branch has no upstream
{"name","path","branch","head","main","locked","dirty","ahead","behind"}
// remove
{"name","path","removed":true,"branchDeleted":false,"hookRan":true}
// cancelled at a prompt
{"aborted":true,"reason":"User cancelled"}
```

Errors come back as `{"error":true,"message":"..."}` with exit code 1, and
carry git's own stderr when git is what failed.

```sh
wt list -j | jq -r '.worktrees[] | select(.main|not) | .name'
cd "$(wt add feature-x -j | jq -r .path)"
cd "$(wt mv feature-x feature-y -j | jq -r .path)"
```

## Shell integration

`add`, `view` and `mv` report the worktree's absolute `.path`, but only a shell
can change its own directory. `wt.sh` provides wrappers that do it (zsh and
bash, needs `jq`). Download it alongside the installed binary, then source it
from `~/.zshrc` or `~/.bashrc`:

```sh
mkdir -p ~/.local/share/wt
curl -fsSL https://loxel.bizimind.io/wt/wt.sh -o ~/.local/share/wt/wt.sh
source ~/.local/share/wt/wt.sh
```

| Helper          | Does                                                                         |
| --------------- | ---------------------------------------------------------------------------- |
| `wta [name]`    | `wt add`, then cd into the new worktree                                      |
| `wtv [name]`    | `wt view`, then cd into it (picker when no name)                             |
| `wtr [name]`    | `wt remove`                                                                  |
| `wtm [old] new` | `wt mv`, then follow the worktree to its new path, keeping your subdirectory |

They call `wt` on PATH; set `WT_BIN` before sourcing to point somewhere else
(a locally built `dist/wt`, say). They live beside the CLI so the wrappers and
the `-j` shapes they parse stay versioned together.

## Environment

| Var              | Effect                                                        |
| ---------------- | ------------------------------------------------------------- |
| `WT_DIR`         | Where worktrees are created (default `<repoRoot>/.worktrees`) |
| `WT_AUTO_UPDATE` | Set to `1` to let wt update itself before running a command   |

## Library API

`@bizimind/wt/lib` exposes the same operations for programmatic use, with the
plan/execute split that lets a UI resolve decisions before mutating anything:

```ts
import {
  planAdd,
  executeAdd,
  planMove,
  executeMove,
  planRemove,
  executeRemove,
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
if (!removal.dirty) {
  await executeRemove({ name: "feat/bar", repoPath, deleteBranch: true, force: false });
}
```

Also exported: `resolveWorktreesDir`, `listManagedWorktrees`,
`currentManagedWorktree`, `getWorktreeName`,
`detectRepoType`, `hasUncommittedChanges`, `getCurrentBranch`, `initBareRepo`,
`transformToBare`, `ensureWorktreesDir`, the hook filename constants, and the
`ProgressHandler` type.

## Development

```sh
bun src/cli.ts add feature-x      # run from source
pnpm -C packages/wt run test      # tests (real temporary git repos)
pnpm -C packages/wt run typecheck
pnpm -C packages/wt run build     # standalone binary at dist/wt
```
