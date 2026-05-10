---
title: Coding Agent
description: The built-in agent with timeline UI, sessions, human interaction, and tool profiles.
order: 8
---

The built-in coding agent gives you a dedicated timeline for every run — user messages, assistant responses, reasoning blocks, tool calls, and plan steps, all visible in sequence. It is not a TUI agent in a terminal. It is a first-class panel in your layout, scoped to the active project and worktree.

---

## Setup

The coding agent connects to [OpenRouter](https://openrouter.ai/). Set your API key before using it:

```bash
OPENROUTER_API_KEY=sk-or-...
```

That is the only required variable. The agent ships with default models for each role:

| Variable                     | Role                                       | Default                |
| ---------------------------- | ------------------------------------------ | ---------------------- |
| `OPENROUTER_API_KEY`         | Authentication (required)                  | —                      |
| `OPENROUTER_MODEL_PLANNER`   | Planning steps                             | `z-ai/glm-5`           |
| `OPENROUTER_MODEL_EXECUTOR`  | Execution steps                            | `moonshotai/kimi-k2.5` |
| `OPENROUTER_MODEL_FALLBACK`  | Fallback                                   | `openrouter/auto`      |
| `OPENROUTER_WEBSEARCH_MODEL` | WebSearch tool (required to use WebSearch) | —                      |

Models are organized by **profile** — planner, executor, fallback. You configure which model each profile uses, not arbitrary per-turn model IDs. You can add or swap models in Settings > Models, and configure which model maps to each profile in Settings > Coding Agent.

---

## Sessions

A session is created automatically when you send your first message. It is scoped to the active project + worktree.

Sessions survive context switches. If you switch worktrees — or navigate away to another panel — the agent subprocess keeps running. When you come back, the full event history replays from the buffer (up to 5,000 events per session). You pick up exactly where you left off.

Sessions do not end on their own. Use the exit action in the agent panel to close a session explicitly.

---

## The timeline

Every run produces a linear sequence of events:

- **User messages** — what you sent
- **Assistant responses** — the agent's reply text
- **Reasoning blocks** — the agent's internal chain of thought, when the model exposes it
- **Tool calls** — each tool invocation with its inputs
- **Tool results** — the output returned to the agent
- **Plan steps** — discrete steps when running in plan mode
- **System events** — run errors, completion signals, mode changes

The timeline is a read-only record of what happened. You can scroll back through any prior run within the session buffer.

---

## Human interaction

The agent can pause and ask for input. Two overlay types appear inline in the timeline:

**Questions** — when the agent needs information before continuing. The overlay presents the question with single or multi-select options, plus an optional freeform text field. Answer and submit to resume the run.

**Approvals** — when the agent wants to run a tool that requires your sign-off. Options:

- **Allow** — permit this one invocation
- **Allow this session** — permit the same tool for the rest of the session
- **Allow always** — add a permanent permission
- **Deny** — block the invocation; the agent receives a denial and can decide how to proceed

---

## Tool profiles

The tools available to the agent depend on the active **tool profile**, configured in Settings > Coding Agent:

| Profile   | Tools                                                                                                                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute` | Full catalog: Read, Write, Edit, MultiEdit, Glob, Grep, Bash, Task, WebFetch, WebSearch, AskUserQuestion, EnterPlanMode, ExitPlanMode, TodoWrite, TodoRead, and more |
| `plan`    | No Bash; mutations only to the plan file                                                                                                                             |
| `minimal` | Read, search, and AskUserQuestion only                                                                                                                               |

The default session mode (execute or plan) is also configurable in Settings > Coding Agent.

`plan` mode is useful when you want the agent to draft a step-by-step plan before taking any action. `minimal` is a read-only research mode — the agent can look at your code and ask clarifying questions but cannot modify anything.

---

## New agent panel

Open a new agent panel with `Cmd+Shift+A`. Like any panel, it can be docked, moved, or split alongside your editor and terminal.

---

> **Prefer a TUI agent?** Claude Code, Codex, OpenCode, Gemini CLI, and any other terminal-based agent run normally in loxel's integrated terminals. Use those when you want full CLI control or an agent workflow you've already configured. The built-in agent is for when you want the timeline visibility and human interaction overlays integrated directly into your layout. See [Terminals](/docs/terminals) for the TUI agent workflow.

---

## See also

- [Terminals](/docs/terminals) — running TUI agents (Claude Code, Codex, Gemini CLI) in loxel's integrated terminals
- [Code Review](/docs/code-review) — reviewing code the agent produces, with anchored comments that survive rewrites
- [Drafts](/docs/drafts) — using draft docs as context for agent tasks
- [Guide: Parallel Workstreams](/docs/guide-parallel-workstreams) — running multiple agents on parallel worktrees
