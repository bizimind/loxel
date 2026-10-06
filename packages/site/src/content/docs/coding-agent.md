---
title: Coding Agent
description: The built-in agent with timeline UI, sessions, human interaction, and tool profiles.
order: 8
---

The built-in coding agent gives you a dedicated timeline for every run — user messages, assistant responses, reasoning blocks, tool calls, and plan steps, all visible in sequence. It is not a TUI agent in a terminal. It is a first-class panel in your layout, scoped to the active project and worktree.

---

## Setup

The coding agent uses models from [OpenRouter](https://openrouter.ai/). Set it up in two steps:

1. **Settings > Models** — add the models you want to use. Each entry has a display name, an OpenRouter model ID, and its own API key; keys are stored encrypted.
2. **Settings > Coding Agent** — pick a **Base Model**, used for every agent function. Turn on **Function Overrides** to use different models for specific functions: Planner, Executor, Fallback, Judge, WebSearch, and WS Fallback. WebSearch does not fall back to the base model, so give it an override to enable it. Plan mode runs on the planner model and execute mode on the executor.

Settings apply to newly created sessions. The same section sets the default session mode (execute or plan) and the default tool profile.

Without settings, the agent falls back to environment variables from the environment Loxel starts in: `OPENROUTER_API_KEY`, and `OPENROUTER_MODEL_PLANNER`, `OPENROUTER_MODEL_EXECUTOR`, `OPENROUTER_MODEL_FALLBACK`, `OPENROUTER_MODEL_JUDGE`, `OPENROUTER_WEBSEARCH_MODEL`, and `OPENROUTER_WEBSEARCH_FALLBACK_MODEL` for each function's model. Loxel launched from Finder or the Dock doesn't read your shell profile's variables, so prefer Settings.

---

## Sessions

A session starts when you open an agent panel. It is scoped to the active project + worktree.

Sessions survive context switches. If you switch worktrees — or navigate away to another panel — the agent session keeps running in the background. When you come back, the session's history replays in the timeline (up to 5,000 events per session). You pick up exactly where you left off.

While a run is active, `Enter` stops it and sends your new message right away (steer), and `Cmd+Enter` queues the message until the run finishes. The agent tab's dot shows the session's state: green while running, amber while waiting for you, gray once it has exited.

---

## The timeline

Every run produces a linear sequence of events:

- **User messages** — what you sent
- **Assistant responses** — the agent's reply text
- **Reasoning blocks** — the agent's internal chain of thought, when the model exposes it
- **Tool calls** — each tool invocation with its inputs, and the output it returned
- **Plan steps** — discrete steps when running in plan mode
- **Tasks** — the agent's todo list
- **System events** — errors, cancelled runs, and plan mode changes

Scroll back through any earlier run in the session's history.

### Rewind and fork

Hover a message or tool call to rewind or fork from that point. **Rewind to here** rolls the session back; rewinding to one of your messages puts its text back in the input so you can edit and resend it. **Fork from here** opens a copy of the session up to that point in a new agent tab, leaving the original untouched. The **Fork Tree** panel (`Ctrl+Shift+K`) shows a session's branches; double-click one to resume it.

---

## Human interaction

The agent can pause and ask for input. Two overlay types appear inline in the timeline:

**Questions** — when the agent needs information before continuing. The overlay presents the question with single or multi-select options, plus an optional freeform text field. Answer and submit to resume the run.

**Approvals** — when the agent wants to run a tool that requires your sign-off. Options:

- **Allow** — permit this one invocation
- **Allow this session** — permit the same invocation (for Bash, the same command; for edits inside the workspace, any file write) for the rest of the session
- **Allow always** — save the permission for this workspace
- **Deny** — block the invocation; the agent receives a denial and can decide how to proceed

Edit, Write, MultiEdit, Bash, and TaskStop ask for approval; leaving plan mode asks you to approve the plan.

---

## Tool profiles

The tools available to the agent depend on the active **tool profile**, configured in Settings > Coding Agent:

| Profile   | Tools                                                                                                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute` | Full catalog: Read, Write, Edit, MultiEdit, Glob, Grep, Bash, Task, TaskOutput, TaskStop, WebFetch, WebSearch, AskUserQuestion, EnterPlanMode, ExitPlanMode, TodoWrite, TodoRead, ToolSearch, Skill |
| `plan`    | Everything in `execute` except Bash, TodoWrite, and Skill                                                                                                                                           |
| `minimal` | Read, Glob, Grep, WebFetch, WebSearch, AskUserQuestion, ToolSearch, and TodoRead                                                                                                                    |

The tool profile and the session **mode** are separate: plan mode is what blocks Bash and limits writes to the plan file, while the `plan` profile only removes tools. Plan mode is useful when you want the agent to draft a step-by-step plan before taking any action. `minimal` is a read-only research profile — the agent can look at your code and the web and ask clarifying questions, but cannot modify anything.

---

## New agent panel

Open a new agent panel with `Cmd+Shift+A`, or in a split with `Cmd+\` then `A` then an arrow. Like any panel, it can be docked, moved, or split alongside your editor and terminal. The bug icon on an agent tab opens its DevTools panel, with the session's events, metrics, and state.

---

> **Prefer a TUI agent?** Claude Code, Codex, OpenCode, Gemini CLI, and any other terminal-based agent run normally in Loxel's integrated terminals. Use those when you want full CLI control or an agent workflow you've already configured. The built-in agent is for when you want the timeline visibility and human interaction overlays integrated directly into your layout. See [Terminals](/docs/terminals) for the TUI agent workflow.

---

## See also

- [Terminals](/docs/terminals) — running TUI agents (Claude Code, Codex, Gemini CLI) in Loxel's integrated terminals
- [Code Review](/docs/code-review) — reviewing code the agent produces, with anchored comments that survive rewrites
- [Drafts](/docs/drafts) — using draft docs as context for agent tasks
- [Guide: Parallel Workstreams](/docs/guide-parallel-workstreams) — running multiple agents on parallel worktrees
