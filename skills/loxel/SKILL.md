---
name: loxel
description: >-
  Drives the Loxel IDE with the `loxel` CLI: show the user a file, folder, page or PR in Loxel, or
  start a dev server, watcher or another agent in a new Loxel terminal. Use when the user mentions
  Loxel or wants something opened or run where they can see it.
---

# Working inside Loxel

Loxel is a desktop IDE for agentic coding. If `LOXEL=1` is set, you are running in one of its terminal panels, in a window the user also uses for editors, diffs, browser panels and other terminals. Use the `loxel` CLI to put things in front of them instead of only describing them.

This skill covers what an agent can do from a Loxel terminal. It does not cover Loxel's settings or its keyboard shortcuts.

## The user's workspace

- **Projects and worktrees.** Loxel's sidebar lists the user's projects (git repositories) and each project's worktrees, so the user moves between repos and branches in one window. Projects are often bare repos with every checkout under `<repo>/.worktrees/<name>`.
- **One layout per worktree.** In each window, every worktree keeps its own panel layout (open editors, terminals, browser tabs). The window shows one worktree at a time. Switching swaps the whole layout, and terminals in the other worktrees keep running, so the user may be looking at a different worktree than yours.
- **Your terminal's environment.** Loxel sets these variables in every terminal it opens:

| Variable          | Value                                                          |
| ----------------- | -------------------------------------------------------------- |
| `LOXEL`           | `1`                                                            |
| `LOXEL_WORKTREE`  | Absolute path of the worktree whose layout holds this terminal |
| `LOXEL_PORT`      | Port of the running Loxel; the CLI connects through it         |
| `LOXEL_WINDOW_ID` | The Loxel window this terminal is in; the CLI targets it       |

## The `loxel` CLI

```
loxel [open flags] <file | folder | url>
loxel terminal [--cwd <dir>] [--title <name>] [open flags] [--] [command...]
loxel                      # launch or focus Loxel

open flags: [--split left|right|up|down | --replace] [--group <tab>] [--focus | --no-focus]
```

```sh
loxel src/upload/client.ts          # open a file in an editor tab, in the background
loxel --focus src/upload/client.ts  # open it and show it to the user
loxel --focus docs/                 # reveal a folder in the file tree
loxel http://localhost:5173         # open a URL in a browser panel
loxel https://github.com/org/repo/pull/42
loxel terminal                      # new terminal tab in the current directory
loxel terminal --title tests -- bun test --watch
loxel terminal 'cd web && pnpm dev' # one argument = a shell command line, used as is
loxel --split right src/app.ts      # open beside the active tab instead of as a tab in its group
```

There is no `--help`: `loxel --help` fails with `unknown option --help` and prints the usage. On success the CLI prints nothing (at most `loxel: waiting for a Loxel window...` while Loxel starts, or a `loxel: warning: ...` line about a flag it ignored) and exits 0. Errors it can detect print `loxel: <message>` to stderr and exit 1. Some requests are accepted and then refused inside Loxel, which shows the user a message while the CLI still exits 0. That happens, for example, with a folder that belongs to a project but to none of its worktrees, such as a bare repo's root.

If `command -v loxel` finds nothing, the CLI isn't installed for this shell. Tell the user, and fall back to the clickable paths and URLs described in [Keep the user oriented](#keep-the-user-oriented).

### Files and folders

- Relative paths resolve against your current directory. The path must exist, and it takes no `:line` suffix: `loxel src/app.ts:42` fails with `File not found`.
- The file or folder opens in your terminal's window, in the worktree that contains it. A path outside every project opens in the Others section of the file tree.
- Folders are revealed in the file tree, which needs `--focus`: without it nothing opens and the CLI prints a warning. Files open as tabs: `.md` in a live-preview markdown editor, `.excalidraw` in a drawing canvas, images, videos and SVGs in a media viewer, and everything else in a code editor.

### URLs

- Only `http://` and `https://` URLs count as URLs. Anything else is treated as a path.
- The URL opens in a browser panel in the windows currently showing the worktree that contains your current directory. If you aren't in a git repository, Loxel uses `LOXEL_WORKTREE`. It never switches worktrees: if no window is showing that worktree, nothing opens and the CLI still exits 0.
- Inside a git repository that isn't one of the user's projects (a cloned dependency, a temp repo), it fails with `No project found for worktree`. Run it from your worktree instead: `(cd "$LOXEL_WORKTREE" && loxel http://localhost:5173)`.
- Good uses: the dev server you just started, a PR you just opened, a deploy preview, the docs page you're citing.

### Terminals

- `loxel terminal` opens a new terminal tab in your window, with its shell started in `--cwd <dir>` (default: your current directory). The tab goes to the worktree that contains the directory, or to the window's current worktree for a directory outside every worktree. Its command starts right away, even when the tab opens in the background or in a worktree the user isn't looking at. A worktree created moments ago inside the project's directory is picked up.
- The new shell is a fresh login shell, like any new tab. It has the user's aliases and shell config but not your environment, so put any variables the command needs in the command itself. The shell stays open after the command exits, and the user can watch the output, scroll back and take over.
- The CLI returns as soon as the tab is requested. It does not wait for the command, and it reports neither the command's output nor its exit code. Run the command yourself when you need its result. Use a new terminal for long-running processes the user should see (dev servers, watchers, log tails) or for handing work to another agent.
- The command is typed into the shell as keystrokes, so keep it on one line. With one argument, that argument is a shell command line used as is (`&&`, pipes and `cd` work). With several arguments, each one is quoted where needed and they are joined into one command, which makes a separate argument the safe way to pass a long prompt. `--` ends `loxel`'s own flags; put it before the command to be safe. `--title` names the tab.

```sh
# Start a dev server in a background tab, then show the user the page
loxel terminal --title dev -- pnpm dev
loxel --focus http://localhost:5173

# Hand a task to a second agent in a fresh worktree of the repo at ~/code/app
git -C ~/code/app fetch origin
git -C ~/code/app worktree add --no-track -b fix/flaky-test ~/code/app/.worktrees/fix/flaky-test origin/main
loxel terminal --cwd ~/code/app/.worktrees/fix/flaky-test --title claude -- claude "Fix the flaky upload test"
```

Create worktrees the way the project already does. If it uses `wt`, `wt add <name>` creates `.worktrees/<name>` and runs the repo's setup hook, which a bare `git worktree add` skips. To show the new worktree nested under yours in Loxel's sidebar, add `--meta loxel-parent-wt=<id>` with your worktree's id from `wt meta get wt-id`. This needs worktree metadata on (`wt init --worktree-metadata on`, which also gives every existing worktree an id). If `wt meta get wt-id` prints nothing, your worktree was created outside `wt`: run `wt init --worktree-metadata on` to give it one.

### Layout flags

By default a file, URL or terminal opens as a new tab in the group of the user's active tab. The layout flags put it somewhere else:

- `--split left|right|up|down` opens it in a new split on that side of the active tab.
- `--replace` puts it in the active tab's place and closes that tab. Not combinable with `--split`.
- `--group <tab>` uses another tab instead of the active one: a file open in a tab (a path, relative to your current directory) or a tab's title as shown on its tab, such as a terminal you named with `--title`. With `--split` the split goes beside that tab, and with `--replace` that tab is replaced. If no open tab matches, the panel opens next to the active tab, Loxel shows the user a message, and the CLI still exits 0.

A file that is already open moves to the requested spot rather than opening twice. Folders ignore layout flags, with a warning. For a file or URL the flags may go before or after it; for `loxel terminal` they go before the command. The user's active tab may not be your terminal, so prefer `--group` with a title you chose when the panel should land next to something specific.

```sh
# A dev server below the active tab, then its tests beside it
loxel terminal --title dev --split down -- pnpm dev
loxel terminal --group dev --split right --title tests -- pnpm test --watch
# Show the page in the group of the file under review
loxel --group src/app.ts http://localhost:5173
```

Use `--replace` sparingly: it closes the user's tab, and a terminal's shell with it. Replacing the tab the user is on shows the replacement there even without focus.

### Focus

Loxel recognizes coding agents by the environment variables they set for their commands (`CLAUDECODE` for Claude Code, `CODEX_SANDBOX` or `CODEX_THREAD_ID` for Codex, `GEMINI_CLI`, `CURSOR_AGENT`, `OPENCODE_CLIENT`, the cross-agent `AI_AGENT`, and a few more). When it recognizes you, your opens default to **no focus**: Loxel isn't brought to the front, the window stays on the worktree the user is looking at, and the panel is added as a background tab, or as a new split that doesn't take the cursor. A panel for another worktree is waiting there when the user switches to it. The user's own `loxel` commands default to focus: the window switches to the panel's worktree and the new tab becomes active.

- `--focus` shows the user what you opened: it switches the window to its worktree and activates the tab. Use it when they asked to see something, or when the hand-off is the point.
- `--no-focus` opens in the background explicitly. Pass it if your agent might not be recognized.
- They can't be combined.

## Keep the user oriented

- Opening with `--focus` switches the window to the worktree the panel belongs to, including your own worktree if the user has moved on to another one. Do that only when they asked for it or when the hand-off is the point. Otherwise open in the background and mention it, or just mention the path.
- Open what the user needs next, such as the file you want reviewed, the page you built, or the PR you created. Don't open every file you touch.
- In your replies, write file references as absolute paths, each on one line, with an optional `:line` or `:line:col` suffix. Loxel makes them Cmd-clickable in terminal output, and URLs too. `./` and `../` paths resolve against the directory this terminal started in, and bare names like `src/app.ts` are clickable only when they match a file in the project.
