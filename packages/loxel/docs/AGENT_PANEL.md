# Agent panel

How the agent panel drives Claude Code without a terminal: the transport-independent session model, the server session and its socket, the Claude Agent SDK transport that runs the user's installed `claude`, how it degrades when the CLI changes, and how it is tested.

## Overview

An agent panel (`component: "agent"`, params `{ agentId, worktreePath, sessionId? }`) shows one Claude Code session. The server drives `claude` through the Claude Agent SDK and translates its messages into a model the panel renders; the panel never sees the CLI's own frames.

```
AgentPanel ── /ws/agent?id=<agentId> ── AgentManager ── AgentSession ── AgentTransport
 (renderer)    snapshot + {seq,event}     (by panel)     state, log      ClaudeSdkTransport
                client messages                                          └ SDK query() → claude
```

## The session model

[agent-session-model.ts](../src/api/agent-session-model.ts) is shared by both sides and knows nothing about Claude Code's wire format:

- `AgentEvent`s are what a transport reports: the session (id, version, model, mode, capabilities), the catalog (commands, models), status, mode/model/effort changes, user messages and their delivery, streamed deltas, finished items, tool results, requests and their resolution, turn results, context usage, hand-off and exit.
- `applyAgentEvent(state, event)` folds them into an `AgentState`: the turn status, the transcript items (user, text, thinking, tool, notice), the pending requests (permission, question, plan), the commands and models, and what the toolbar shows. It is pure; the server and the renderer run the same function, so a snapshot plus the events after it always equals the server's state. An unknown event changes nothing.
- `agentDisplayStatus(state)` is the status the tab shows: `needs_input` while a request is pending, whatever the turn does.
- `AgentClientMessage` (zod-validated on the server by `parseAgentClientMessage`) is what the panel sends: attach, send (queue or steer, images), interrupt, respond, set mode/model/effort, refresh context usage, hand off, resume, destroy. `AgentResponse` answers a request by kind.

## Server

[src/server/agent/](../src/server/agent/) (entry [index.ts](../src/server/agent/index.ts)):

- **Socket.** `server.ts` upgrades `/ws/agent?id=<uuid>` (after the server-wide [request origin checks](ARCHITECTURE.md#request-origin-checks)) and hands each JSON message to `AgentManager.handle`. A closed socket detaches its client; the session keeps running.
- **Manager.** [agent-manager.ts](../src/server/agent/agent-manager.ts) keys sessions by panel id. The first `attach` creates the session: with `resumeSessionId` it loads the transcript (below) and resumes; without one, or when no transcript exists (the session never got a message), it starts a new session under that id. `destroy` (sent by `CenterHost` when the panel closes) stops it; server shutdown stops all of them.
- **Session.** [agent-session.ts](../src/server/agent/agent-session.ts) owns the transport, the state and a log of the last 2000 events with sequence numbers. An attach with `sinceSeq` still covered by the log gets only the events after it; anything else gets a snapshot. `hand_off` stops the process and marks the state handed off; `resume` starts it again on the same session id.
- **Starting values.** So the composer shows real values from the panel's first frame, [claude-settings.ts](../src/server/agent/claude-settings.ts) reads the user's, the project's and the local settings files (`model`, `effortLevel`, `modelSettings.<model>.effortLevel`, `permissions.defaultMode`) and the env overrides (`ANTHROPIC_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL`) before the process starts, together with the model catalog the last session reported; the transport's settings call replaces them moments later.
- **Rewind.** The normalizer records, on each user message, the conversation entry just before it (`resumeAt`: the last main-thread assistant or user entry's uuid; null for the first message). `rewind` in [agent-session.ts](../src/server/agent/agent-session.ts) restores the files first through the transport's `rewindFiles`, then stops the process and starts a fork at `resumeAt` under a new session id (a fresh session for the first message), emitting `rewound`, which truncates the transcript and gives the panel the new id.
- **Prompt history.** [claude-history.ts](../src/server/agent/claude-history.ts) reads the CLI's `history.jsonl` lines whose `project` is the worktree for the composer, and appends each prompt the panel sends in the same shape, so the panel and the TUI share one history. Print mode writes none itself.
- **Sessions.** [claude-transcript.ts](../src/server/agent/claude-transcript.ts) lists a worktree's sessions for the picker from its project directory (`<config dir>/projects/<cwd with every non-alphanumeric character a dash>/*.jsonl`, the TUI's sessions included): title (`custom-title`, else `ai-title` records), first prompt, prompt count and branch, newest first, cached by file mtime and size. `open_session` switches a panel to another session (`AgentSession.switchTo`: stop, a `reset` event, the session's history, start): `resume` continues it as itself, `fork` starts a new id with `forkFrom` (`--resume <id> --fork-session --session-id <new>`), `continue` resumes the worktree's most recent other session. A panel created with `forkFrom` ("Fork from here") forks its source cut at an entry, and keeps forking it on restart until its fork has a message of its own on disk.
- **Transcript.** A print-mode `--resume` replays nothing, so [claude-transcript.ts](../src/server/agent/claude-transcript.ts) reads the session's JSONL (`<CLAUDE_CONFIG_DIR or ~/.claude>/projects/*/<session id>.jsonl`, found by id) and turns the user and assistant records of its main conversation into events with the same normalizer. A transcript is a tree (a TUI rewind leaves the abandoned branch in the file), so only the `parentUuid` chain back from the last message, or from a fork point, is replayed. This is what brings a conversation back after a server restart: the panel's `sessionId` param survives in the layout.

## The Agent SDK transport

[claude-sdk-transport.ts](../src/server/agent/claude-sdk-transport.ts) implements [`AgentTransport`](../src/server/agent/agent-transport.ts) with one long-lived streaming `query()` of `@anthropic-ai/claude-agent-sdk` per session. User messages go in through an async iterable; the SDK's messages are the CLI's stream-json frames and go through the same [claude-stream-normalizer.ts](../src/server/agent/claude-stream-normalizer.ts) a raw stream-json client would use. The options are what make it behave like `claude` in a terminal:

- `pathToClaudeCodeExecutable`: the `claude` on the spawn `PATH`, never the binary the SDK package bundles, so the user's version, login and configuration apply. The environment is the spawn environment with `withoutAgentEnv` applied, plus `LOXEL`, `LOXEL_PORT` and `LOXEL_WORKTREE` so `loxel` works from the agent's commands.
- `systemPrompt: { type: "preset", preset: "claude_code" }`: without it the SDK sends an empty system prompt.
- `canUseTool`: without a handler the CLI leaves AskUserQuestion, EnterPlanMode and ExitPlanMode out of the toolset. Its arguments are rebuilt into the `can_use_tool` request shape `parsePermissionRequest` reads, and the call waits for the user's answer; an interrupt aborts it and withdraws the card.
- `includePartialMessages` for streamed deltas, and `extraArgs: { "replay-user-messages": null }`, so each user message is echoed when the CLI takes it, which is how a queued message is marked delivered.
- `enableFileCheckpointing`, so `rewindFiles` can restore the files the agent edited since a message (with `dryRun` for the preview).
- `sessionId` for a new session, `resume` for an existing one, and for a fork `resume` with `forkSession` under a new `sessionId`, plus `resumeSessionAt` for a conversation rewind or a fork from a message: a new session holding the conversation (up to that entry), the original transcript untouched. No model, mode or effort options: the user's settings apply.

The SDK's `Query` methods carry the rest: `initializationResult()` (commands, models with their effort levels, current permission mode, session state), `interrupt`, `setPermissionMode`, `setModel`, `applyFlagSettings({ effortLevel })` and `getContextUsage({ detail: "summary" })`. The starting model and effort come from the SDK's `getSettings`, which exists at runtime but not in the SDK's types; it is looked up and its absence tolerated.

Answers to requests are permission results: question answers go in `updatedInput.answers`; "always allow" sends back the agent's own suggestions with the destination the user picked, rebuilt on the server from the request it holds; plan approval adds a `setMode` update for the chosen mode, so the mode changes in the same turn. MCP elicitations are not handled, so the SDK declines them.

`stop()` denies pending requests, interrupts, closes the query and resolves once the message stream has ended, which is when the CLI has exited, so a hand-off never lets two processes write one session.

### Degrading instead of breaking

Everything the CLI writes is checked field by field by the normalizer; unknown message types, subtypes and fields are skipped. The SDK and the user's CLI are versioned separately, so features that depend on the CLI gate on the init message's `capabilities` and version, kept in the state. Anything the panel cannot show (MCP elicitations, TUI-only commands such as `/login` or `/permissions`) goes through the hand-off: "Continue in terminal" stops the process and opens `claude --resume <id>` in a terminal panel through `POST /api/open`; "Resume here" starts the query again once the user has quit Claude there.

### Repository trust

Print mode, which the SDK runs, skips Claude Code's own "trust this folder" prompt, so the project's hooks and settings would run unasked. The transport refuses to start in a repository Loxel does not trust and reports the restriction, which shows Loxel's trust prompt; the panel's "Resume here" starts it once trusted.

## Testing

[claude-sdk-transport.test.ts](../src/server/agent/claude-sdk-transport.test.ts) drives the transport with a scripted `query` in place of the SDK's: the options it passes, the starting values, the `canUseTool` round trip for permissions and plans, aborts, queued messages and stop. The normalizer, the session, the manager, the settings and the transcript reader have their own tests.

## Renderer

[src/components/agent/](../src/components/agent/):

- `useAgentSession`: the socket, reconnect with `sinceSeq` and `instanceId`, and `resumeSessionId`.
- `AgentPanel`: lays out the transcript and the composer, keeps `sessionId` in the panel params and the status in [agent-status.ts](../src/store/agent-status.ts) for [agent-tab.tsx](../src/components/dockview/agent-tab.tsx), and runs the hand-off.
- `AgentTranscript`: groups consecutive tool calls and thinking ([agent-activity.ts](../src/components/agent/agent-activity.ts), pure and tested) into one summary line on a rail; entries open file paths in the editor, show Bash commands with collapsed output and edits as diffs in the diff colours; subagent items nest under their Task call. Pending requests render through `renderRequest` at the call that asked.
- `AgentRequestCard`: the permission, question and plan cards, the only raised surfaces, with numbered shortcuts that work only once the card has focus.
- `AgentComposer` and `AgentControls`: one surface whose footer holds the model, effort and mode pill menus (`dropdown-menu`), the status line above it, and the `/` command list (wrapping arrows, Home/End, Page Up/Down, kept in view).
- `AgentRewind`: double Escape selects the last rewindable message, Up/Down move, Enter opens the choice (code and conversation, conversation, code, never mind) with a `rewind_preview` of the files; a conversation rewind puts the message back in the composer, whose Up/Down walk the prompt history from its first and last lines, keeping the draft.
- `AgentSessionPicker`: the worktree's sessions in Loxel's `PickerDialog`, searchable, with a Resume/Fork toggle; opened from the status line's Sessions button, the empty panel (next to "Continue latest"), and `/resume` typed in the composer.
- `AgentMarkdown`: messages in the Settings > Fonts prose font and size with the editor's proportions ([agent-transcript.css](../src/styles/agent-transcript.css)) and Shiki code blocks in the read-only code theme.
