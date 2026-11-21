---
title: Loxel CLI
description: Open files, folders, URLs and terminals in Loxel from the command line, from you or from your agents.
section: "Agents"
order: 2
---

`loxel` puts things on screen from the command line. You use it to open a file without hunting for it; your agents use it to show you what they did: the file to review, the dev server they started, the PR they opened. It runs in every Loxel terminal, already connected to the window it belongs to.

```bash
loxel src/app.ts                                  # open a file
loxel ~/notes                                     # reveal a folder in the file tree
loxel https://example.com                         # open a URL in a browser panel
loxel terminal --split right -- pnpm dev          # run a command in a new split beside the active tab
loxel terminal --cwd ../other-worktree -- claude  # start an agent in another worktree
```

## Installing

Loxel ships the CLI and puts it on the `PATH` of every Loxel terminal, so there is nothing to install there, and it updates with the app. To use it in other terminals too, link it into a directory on your `PATH`:

```bash
mkdir -p ~/.local/bin && ln -sf /Applications/Loxel.app/Contents/Resources/bin/loxel ~/.local/bin/loxel
```

Each [release](https://github.com/bizimind/loxel/releases) also lists the CLI on its own for macOS. A downloaded copy doesn't update with the app, so the link above is the better choice when Loxel is installed. A directory your shell's startup files put first on `PATH` wins over the bundled CLI in Loxel terminals too, so remove an old copy of `loxel` from it, or link it as above.

---

## Usage

```
loxel [open flags] <file-path | folder-path | url>...
loxel terminal [--cwd <dir>] [--title <name>] [open flags] [--] [command...]
loxel --version

open flags: [--split left|right|up|down | --replace] [--group <tab>] [--worktree <path>] [--focus | --no-focus]
```

| Invocation                              | Behavior                                                  |
| --------------------------------------- | --------------------------------------------------------- |
| `loxel`                                 | Launch Loxel if not running, or focus the existing window |
| `loxel src/app.ts`                      | Open a file in an editor (see below)                      |
| `loxel ~/notes`                         | Reveal a folder in the file tree (see below)              |
| `loxel https://...`                     | Open a URL in Loxel's browser panel                       |
| `loxel docs/*.md`                       | Open every file the shell expands the pattern to          |
| `loxel terminal`                        | Open a terminal panel in the current directory            |
| `loxel terminal -- claude "Fix the CI"` | Open a terminal and run a command in it (see below)       |
| `loxel --split right src/app.ts`        | Open a file in a new split beside the active tab          |
| `loxel terminal --group server`         | Open a terminal in the same group as the `server` tab     |
| `loxel --no-focus src/app.ts`           | Open a file in the background, leaving your view as it is |
| `loxel --worktree ../other https://...` | Open a URL in another worktree                            |

---

## Finding Loxel

`loxel` talks to Loxel through a socket in Loxel's state directory, `~/.local/state/loxel/loxel/run/cli.sock` (`loxel-dev` instead of `loxel` in dev mode). Only your own user account can open it, so other accounts on the same Mac can't use it to drive your Loxel; if the Loxel it finds runs as another user, or the socket's folder is open to other accounts, `loxel` says so and doesn't use it.

Inside a Loxel terminal, `loxel` connects to the socket in `LOXEL_SOCKET`, the one of the Loxel that terminal belongs to. While that Loxel restarts or installs an update, `loxel` waits for it to come back. If you quit Loxel and kept your terminals, `loxel` in one of them waits a few seconds, then launches Loxel in the background, and your file opens once Loxel is ready. Elsewhere it looks for a running Loxel on its socket, the regular one first, then dev mode's, and, when the open takes focus (see [Focus](#focus)), brings Loxel to the front. If no Loxel is found, Loxel launches and the CLI waits up to 15 seconds for it to become ready.

If Loxel can't set up its socket when it starts, a notification under the bell names the socket and the reason. Loxel itself works as usual, but `loxel` can't reach it until it restarts.

### Agents in a sandbox

An agent that runs its commands in a sandbox can use `loxel` only if the sandbox lets it connect to Loxel's socket. When it can't, `loxel` prints `Loxel's socket <path> is outside this sandbox: allow it in the sandbox's settings`. Add that path to the Unix sockets the sandbox allows: in Claude Code, for example, to `sandbox.network.allowUnixSockets` in its settings.

---

## Files and folders

`loxel <path>` goes to the window you are working in: the window of the Loxel terminal it runs in, or else the most recently focused Loxel window. Other windows are left alone. A file or folder inside one of your projects' worktrees opens in that worktree, switching to it if needed when the open takes focus (a folder is revealed in the file tree). Anything else opens in the [Others section](/docs/editor#other-folders) of that window's active worktree, so files don't need to be inside a git repository. To use a different worktree, see [Choosing the worktree](#choosing-the-worktree). If Loxel is still starting, the CLI prints `waiting for a Loxel window...` and waits up to 30 seconds for a window to connect; if no window is open at all, see [When no window is open](#when-no-window-is-open). Files and folders opened from Finder take the same path (see [Opening files from Finder](/docs/editor#opening-files-from-finder)).

---

## URLs

`loxel <url>` opens in the worktree that contains the current directory. Inside a Loxel terminal, it falls back to `LOXEL_WORKTREE` when the current directory isn't in a git repository, and in a Home terminal, which has none, the page opens in what that terminal's window shows; otherwise that URL errors. It goes to the windows showing that worktree: layout flags and focus apply only in the window you are working in, and other windows showing it get the page as a background tab. If no window shows it, the page opens there in the window you are working in, switching to the worktree when the open takes focus. See [Browser](/docs/browser) for what you can do with the page once it's open.

---

## Several targets

`loxel` takes any number of files, folders and URLs, so shell patterns work: `loxel docs/*.md`. They open in the order given, each taking focus in turn when the open takes focus. A target that can't be opened prints an error naming it and the others still open; the command then exits with status 1. A command with a URL opens its files in the URL's worktree too. A command of only files opens each one as usual, in its own worktree.

---

## Choosing the worktree

`--worktree <path>` opens every target of the command in the worktree containing `<path>`, even a file that belongs to another worktree, instead of working it out from the target or the current directory. `<path>` is relative to the current directory, and the worktree must belong to one of your projects. `loxel terminal --worktree <path>` also starts the shell there, unless `--cwd` says otherwise. Folders ignore it, with a warning: they are revealed in the worktree that holds them, or else in your active worktree's Others section.

---

## Terminals

`loxel terminal` opens a new terminal panel in the same window as a file would: the window of the Loxel terminal it runs in, or else the most recently focused window. The shell starts in the current directory, or in `--cwd <dir>`. A directory inside one of your worktrees opens the panel in that worktree, switching to it if needed when the open takes focus; any other directory gets a panel in the window's active worktree, or in Home when the window shows none. `--title <name>` names the tab.

Everything after the flags (or after `--`) is a command typed into the shell once it starts, exactly as if you had entered it: your login shell, aliases and history all apply, and the shell stays open after the command exits. A single argument is a shell command line (`loxel terminal 'cd src && make'`); several arguments are passed as one command with each argument quoted where needed, so `loxel terminal -- claude "Fix the failing tests"` types `claude 'Fix the failing tests'` and an alias for `claude` still applies. Put `--` before commands that have flags of their own. Since the command is typed as keys, it can't contain control characters such as tab, carriage return or escape, which the shell would read as editing keys; newlines are allowed.

The CLI returns once the shell is running; it does not wait for the command. The command runs right away, even if you never look at the new tab, and if the shell can't be started the CLI exits with an error instead. The command is typed before your shell finishes starting, so a startup script that reads from the terminal would consume it. Since `terminal` is a subcommand, open a file or folder of that name as `loxel ./terminal`.

### Terminals your agents start

When a coding agent runs `loxel terminal` (Loxel recognizes agents as described in [Focus](#focus)), the **When an Agent Starts a Terminal** setting in **Settings > Terminal** decides what happens:

- **Run** (the default): the terminal starts at once, like one you start yourself.
- **Ask**: nothing starts yet. A prompt in the window names the agent, the worktree and the command, and the folder the shell starts in when that isn't the worktree, with **Run**, **Always in this worktree** and **Don't run**. Characters that wouldn't otherwise show, such as right-to-left overrides and zero-width spaces, appear as escapes like `\u202e`, and a command of several lines says how many it has. **Always in this worktree** runs this terminal, the ones already waiting for that worktree, and every later one an agent starts there, without asking; **Settings > Terminal** lists those worktrees, and **Clear** makes Loxel ask in them again. The agent isn't kept waiting: `loxel` prints that Loxel is asking you, and exits with status 3. If no window is open, the next window you open asks. A terminal that runs after you answer opens beside your active tab rather than replacing it, even if the agent asked to replace a tab. Requests still waiting when Loxel quits or restarts are dropped, and the agent has to ask again.
- **Never**: `loxel` prints that the setting blocks it and exits with status 1.

Your own `loxel terminal` commands always run, whatever the setting. Opening files, folders and URLs isn't affected either.

Every terminal an agent started says so in its tab's tooltip: which agent, and, when the agent ran in a Loxel terminal, which terminal and worktree it came from.

This setting keeps agents polite; it isn't a security boundary. It applies to agents that run `loxel terminal` as Loxel recognizes them, and any program running as you can start a shell without asking Loxel. If your agents run their commands in a sandbox and you let it reach Loxel's socket (see [Agents in a sandbox](#agents-in-a-sandbox)), **Never** (or **Ask**) keeps an agent's `loxel terminal` from starting a shell outside that sandbox; an agent set on getting out could still hide what it is, so where the sandbox must hold, don't let it reach the socket at all.

---

## Layout flags

By default a file, URL or terminal opens as a new tab in the group of the active tab. Layout flags choose another spot, in the layout of the worktree the panel opens in:

- `--split left|right|up|down` opens the panel in a new split on that side of the active tab, like the split shortcuts in [Panel Layout](/docs/panel-layout#rearranging-panels). Several targets share one new split, as tabs.
- `--replace` puts the panel in the active tab's place and closes that tab. It can't be combined with `--split`, and takes a single target.
- `--group <tab>` opens the panel in the group holding another tab instead of the active one: a file open in a tab (`--group src/app.ts`, relative to the current directory) or a tab's title as shown on the tab (`--group "Terminal 2"`, or a name you gave with `--title`). If several tabs have that title, the active one wins, then one that is visible in its group. With `--split` the new split goes beside that tab, and with `--replace` that tab is the one replaced. If no open tab matches, the panel opens next to the active tab and Loxel shows a message.

If the file is already open, its tab moves to the requested spot instead of opening a second copy. Without layout flags, an open file's tab is just focused where it is. Folders are revealed in the file tree, so layout flags don't apply to them: the folder still opens, and the CLI prints a warning. For `loxel <path>` the flags can go before or after the path, and a path that starts with `-` goes after `--`. For `loxel terminal` they go before the command.

---

## Focus

With focus, an open shows you what it opened: Loxel comes to the front when you run `loxel` outside it, the window switches to the worktree the panel belongs to, and the new tab becomes the active one. Without focus, your view stays as it is: Loxel is not brought to the front (only launched if it isn't running), the window stays on its worktree, and the panel is added as a background tab, or as a new split that doesn't take the cursor. Replacing the tab you are on with `--replace` still shows its replacement in its place. A panel for another worktree is waiting there when you next switch to it, and a terminal's command starts running right away, even though you haven't looked at it yet. An already-open file isn't activated, though layout flags still move its tab. A folder can only be revealed with focus, so without it nothing opens and the CLI prints a warning.

`--focus` and `--no-focus` choose explicitly (they can't be combined). Without either, the default depends on who runs the command: you get focus, and a coding agent doesn't, so an agent's opens never pull you away from what you are doing. The CLI recognizes coding agents by the environment variables they set for the commands they run: `CLAUDECODE` (Claude Code), `CODEX_SANDBOX`, `CODEX_CI` or `CODEX_THREAD_ID` (Codex), `GEMINI_CLI` (Gemini CLI), `CURSOR_AGENT` (Cursor), `OPENCODE_CLIENT` (opencode), `AUGMENT_AGENT` (Augment), `ANTIGRAVITY_AGENT` (Antigravity), `CLAUDE_CODE`, and the cross-agent `AI_AGENT`.

---

## When no window is open

On macOS, Loxel keeps running after you close its last window, and agents keep working in its terminals. What `loxel` opens then isn't lost: it waits for the next Loxel window, and the CLI prints `loxel: no Loxel window is open; this will open in the next window to connect` and succeeds. A `loxel terminal` command starts running right away, without its panel.

When you open a window (click Loxel in the Dock, for example), everything that waited opens in it, in the order it was asked for, each in its worktree without switching the window there, and a notification for each worktree says what opened while you were away, such as **2 terminals and a file opened while you were away**. Click the notification to go there. Until you go there, they stay safe: if the window reloads or closes first, they open in the next one. Opens wait through a restart of Loxel, up to 100 of them, for at most 3 days. A folder doesn't wait: `loxel <folder>` reveals it in an open window, so with none it fails right away with **No Loxel window is open to show the folder in**. A terminal still has to be running to open: one that ended in the meantime, for example because you quit Loxel and ended its terminals, is dropped.

When `loxel` brings Loxel to the front, or launches it, it waits for the window that comes up instead, as long as 30 seconds, so your own opens show up the moment the window does.

---

## Examples

Start an agent in a fresh worktree right after creating it:

```bash
wt add feat/retry-uploads
loxel terminal --cwd .worktrees/feat/retry-uploads --title claude -- claude "Add retries to the upload client"
```

Keep a dev server and its tests side by side:

```bash
loxel terminal --title dev --split down -- pnpm dev
loxel terminal --group dev --split right -- pnpm test --watch
```

---

## See also

- [Running Coding Agents](/docs/coding-agents#teach-your-agent-about-loxel) — install the skill that teaches your agent to use `loxel`
- [Terminals](/docs/terminals#injected-environment-variables) — the variables every Loxel terminal starts with
