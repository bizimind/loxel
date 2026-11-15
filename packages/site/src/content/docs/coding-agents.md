---
title: Running Coding Agents
description: Run Claude Code, Codex or any other terminal agent in each task, get notified when one needs you, and teach your agent to use Loxel.
section: "Agents"
order: 1
---

Loxel doesn't come with an agent. It runs yours. Claude Code, Codex, OpenCode, Gemini CLI, or whatever ships next month: if it runs in a terminal, it runs in Loxel, with your own subscription, your own settings and nothing to configure.

---

## One agent per task

A task is a worktree, so each agent gets its own checkout and branch to work on. Switch to the task, press `Cmd+T` and start your agent:

```bash
claude
```

The terminal starts in the task's worktree, so your agent does too, no `cd` needed. Hand it the job, then go do something else. Its terminal keeps running while you work in another task, and when you come back the session is where you left it, scrollback included.

Run as many as you like: one agent in each of ten tasks, or two side by side in split terminals of the same task. Put an agent's terminal next to the editor, or give it a group of its own. It's a panel like any other (see [Panel Layout](/docs/panel-layout)).

You don't have to switch tasks to start one, either. From any Loxel terminal, `loxel terminal` opens a terminal in another worktree and types the command for you. With `--no-focus` you stay where you are, and the agent gets going in the background:

```bash
loxel terminal --no-focus --cwd ../fix-login --title claude -- claude "Fix the login redirect loop"
```

See [Loxel CLI](/docs/cli#terminals) for the details.

---

## Notifications

With ten agents going, you need to know which one is waiting on you. Terminal programs raise Loxel notifications with the OSC 9 (iTerm2), OSC 777 (rxvt-unicode) and OSC 99 (Kitty) escape sequences, and many agents can send them: look for a terminal or iTerm2 notification option in your agent's settings. Choose which sequences Loxel listens to in **Settings > Terminal**.

A notification shows up under the bell in the top bar and as a dot on its worktree in the sidebar, and a folded worktree shows the notifications of the worktrees nested in it. Press `` Ctrl+` `` to jump straight to the panel that raised the most recent one.

---

## Multi-line prompts

`Shift+Enter` and `Ctrl+Enter` send the modified-Enter sequences agents use to insert a newline instead of submitting, so you can write a longer prompt without sending half of it.

---

## Teach your agent about Loxel

The [`loxel` agent skill](https://github.com/bizimind/loxel/tree/main/skills/loxel) tells Claude Code, or any other agent that supports skills, that it is running inside Loxel and how to use the [`loxel` CLI](/docs/cli). With it, an agent opens the files it wants you to review, shows the dev server or PR it just started in a browser panel, and starts long-running commands or other agents in terminals of their own. Its opens land in the background, so they never pull you away from what you're doing. The agent needs the `loxel` CLI on its `PATH`, which every Loxel terminal has.

To install the skill for Claude Code (run it again to update):

```bash
mkdir -p ~/.claude/skills/loxel
curl -fsSL https://raw.githubusercontent.com/bizimind/loxel/main/skills/loxel/SKILL.md -o ~/.claude/skills/loxel/SKILL.md
```

Or link it from a clone of the repository, so `git pull` there keeps it current:

```bash
git clone https://github.com/bizimind/loxel.git ~/src/loxel
mkdir -p ~/.claude/skills && rm -rf ~/.claude/skills/loxel
ln -s ~/src/loxel/skills/loxel ~/.claude/skills/loxel
```

For other agents, put the `skills/loxel` folder in their skills directory.

---

## See also

- [Working on Parallel Tasks](/docs/parallel-tasks) — a task from first prompt to commit, with an agent doing the typing
- [Guide: Reviewing Agent Code](/docs/guide-reviewing-agent-code) — reading what the agent wrote, with comments that survive its rewrites
- [Terminals](/docs/terminals) — find, links, Python and Node environments, and everything else a Loxel terminal does
- [Loxel CLI](/docs/cli) — every command and flag
