# cc-git-editor

Agent-friendly git commands that don't block. Intercepts `git rebase -i` and `git add -p` to provide non-blocking execution for AI coding agents while preserving normal UX for humans.

## Why?

Interactive git commands like `git rebase -i` and `git add -p` open an editor and block until it closes. This works for humans but breaks agent workflows where:

- The agent can't interact with editors
- Blocking indefinitely wastes context and resources
- The agent needs to edit files with standard tools, not custom protocols

cc-git-editor solves this by detecting agent mode (`CLAUDECODE=1`) and transforming these commands into non-blocking workflows.

## Installation

```bash
# Build
bun run build

# Install to ~/.local/bin
cp dist/git dist/agentic-editor dist/continue-rebase dist/apply-staged-edits ~/.local/bin/
for bin in git agentic-editor continue-rebase apply-staged-edits; do codesign -s - ~/.local/bin/$bin; done
```

Ensure `~/.local/bin` is in your PATH before `/usr/bin` so the wrapper intercepts git commands.

## Binaries

| Binary               | Description                                               |
| -------------------- | --------------------------------------------------------- |
| `git`                | Wrapper that intercepts specific commands in agent mode   |
| `agentic-editor`     | Sequence editor that waits for signal instead of blocking |
| `continue-rebase`    | Signals the editor to continue with rebase                |
| `apply-staged-edits` | Applies edited files to git staging area                  |

## Usage

### Interactive Rebase (`git rebase -i`)

**Human mode** (no `CLAUDECODE=1`): Normal git behavior - opens editor, blocks.

**Agent mode** (`CLAUDECODE=1`):

```bash
$ git rebase -i HEAD~3
Starting interactive rebase in agent mode...

Using agent-compatible rebase editor.

Edit the rebase TODO file at: /path/to/.git/rebase-merge/git-rebase-todo

When ready, run: continue-rebase 12345
To abort, run: git rebase --abort
```

The agent can then:

1. Read and edit the todo file at the printed path
2. Run `continue-rebase <pid>` to proceed
3. Handle any conflicts with standard git commands

### Partial Staging (`git add -p`)

**Human mode**: Normal git behavior - interactive hunk selection.

**Agent mode**:

```bash
$ git add -p
Agentic staging mode.

Files copied to: /path/to/.git/.cc-git-editor/staged/
  src/foo.ts
  src/bar.ts

Edit files to show exactly what you want staged.
Remove changes you don't want committed, keep changes you do.

When ready, run: apply-staged-edits
To cancel, run: rm -rf /path/to/.git/.cc-git-editor/staged
```

The agent can then:

1. Edit the copied files in the staged directory
2. Remove lines/changes that shouldn't be staged
3. Run `apply-staged-edits` to stage the exact content

## Agent Detection

Agent mode is enabled when `CLAUDECODE=1` environment variable is set. Claude Code sets this automatically.

All other git commands pass through to the real git unchanged.

## Architecture

```
git (wrapper)
├── Detects CLAUDECODE=1
├── Intercepts: rebase -i, add -p
└── Passes through all other commands

agentic-editor (GIT_SEQUENCE_EDITOR)
├── Prints todo file path
├── Waits for SIGTERM
└── Exits 0 on signal (rebase continues)

continue-rebase
├── Validates PID is agentic-editor
└── Sends SIGTERM to continue

apply-staged-edits
├── Reads edited files from staging dir
├── Uses git hash-object + update-index
└── Stages exact content
```

## Development

```bash
# Build individual binaries
bun run build:git
bun run build:agentic-editor
bun run build:continue-rebase
bun run build:apply-staged-edits

# Build all
bun run build

# Install all to ~/.local/bin
cp dist/git dist/agentic-editor dist/continue-rebase dist/apply-staged-edits ~/.local/bin/
for bin in git agentic-editor continue-rebase apply-staged-edits; do codesign -s - ~/.local/bin/$bin; done
```

## License

[FSL-1.1-ALv2](../../LICENSE) — source available for non-competing use; converts to Apache 2.0 on May 10, 2028.
