# Agent panel

How the agent panel drives Claude Code without a terminal: the transport-independent session model, the server session and its socket, the stream-json transport that speaks Claude Code's control protocol to the user's installed `claude`, how it degrades when the CLI changes, and how it is tested.

## Overview

An agent panel (`component: "agent"`, params `{ agentId, worktreePath, sessionId? }`) shows one Claude Code session. The server runs `claude -p` with stream-json input and output and translates between it and a model the panel renders; the panel never sees the CLI's own frames.

```
AgentPanel ── /ws/agent?id=<agentId> ── AgentManager ── AgentSession ── AgentTransport
 (renderer)    snapshot + {seq,event}     (by panel)     state, log      ClaudeStreamTransport
                client messages                                          └ claude -p (stdio)
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
- **Starting values.** So the composer shows real values from the panel's first frame, [claude-settings.ts](../src/server/agent/claude-settings.ts) reads the user's, the project's and the local settings files (`model`, `effortLevel`, `modelSettings.<model>.effortLevel`, `permissions.defaultMode`) and the env overrides (`ANTHROPIC_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL`) before the process starts, together with the model catalog the last session reported; the transport's `get_settings` replaces them moments later.
- **Transcript.** A print-mode `--resume` replays nothing, so [claude-transcript.ts](../src/server/agent/claude-transcript.ts) reads the session's JSONL (`<CLAUDE_CONFIG_DIR or ~/.claude>/projects/*/<session id>.jsonl`, found by id so the project directory encoding does not matter) and turns its user and assistant records into events with the same normalizer. This is what brings a conversation back after a server restart: the panel's `sessionId` param survives in the layout.

## The stream-json transport

[claude-stream-transport.ts](../src/server/agent/claude-stream-transport.ts) implements [`AgentTransport`](../src/server/agent/agent-transport.ts). It spawns the `claude` found on the spawn `PATH` in the panel's worktree, with `withoutAgentEnv` applied and `LOXEL`, `LOXEL_PORT` and `LOXEL_WORKTREE` added so `loxel` works from the agent's commands:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --permission-prompt-tool stdio --include-partial-messages --replay-user-messages \
  (--session-id <id> | --resume <id>)
```

- `--permission-prompt-tool stdio` (a hidden flag) routes permission prompts to stdout as `can_use_tool` control requests. Without a prompt handler the CLI also leaves AskUserQuestion, EnterPlanMode and ExitPlanMode out of the toolset.
- `--replay-user-messages` echoes each user message when the CLI takes it, which is how a queued message is marked delivered.
- No model, mode or effort flags: the user's settings apply, as in a terminal. No `systemPrompt` in `initialize`: the CLI then uses Claude Code's own prompt.

The protocol subset:

| Direction | Frame                                                                                                                                                          | Use                                                                                                                                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| out       | `control_request initialize`                                                                                                                                   | Response carries commands, models (with effort levels), current permission mode, session state                                                                                                                            |
| out       | `user` with `uuid`, `priority` `next` (queue) or `now` (steer), `origin: human`                                                                                | Prompts, images as base64 blocks                                                                                                                                                                                          |
| out       | `control_request` `interrupt`, `set_permission_mode`, `set_model`, `apply_flag_settings {effortLevel}`, `get_context_usage {detail: summary}`                  | Toolbar and composer                                                                                                                                                                                                      |
| in        | `control_request can_use_tool`                                                                                                                                 | Permission, AskUserQuestion (`requires_user_interaction`) and ExitPlanMode requests                                                                                                                                       |
| out       | `control_response` `{behavior: allow, updatedInput, updatedPermissions?}` or `{behavior: deny, message}`                                                       | Answers: question answers go in `updatedInput.answers`; "always allow" echoes the suggestions with the destination the user picked; plan approval adds `setMode` to the chosen mode, so the mode changes in the same turn |
| in        | `control_cancel_request`                                                                                                                                       | A pending request the CLI withdrew (after an interrupt)                                                                                                                                                                   |
| in        | `control_request elicitation`                                                                                                                                  | Declined, with a notice to continue in a terminal                                                                                                                                                                         |
| in        | other `control_request`s                                                                                                                                       | Answered with an error: Loxel registers no hooks, MCP servers or dialog kinds                                                                                                                                             |
| in        | `system` init/status/session_state_changed/commands_changed/local_command_output/compact_boundary/task_*, `stream_event` deltas, `assistant`, `user`, `result` | Normalized by [claude-stream-normalizer.ts](../src/server/agent/claude-stream-normalizer.ts)                                                                                                                              |

`stop()` interrupts, closes stdin and kills the process if it has not exited after 3 seconds.

### Degrading instead of breaking

Everything the CLI writes is checked field by field; unknown frame types, subtypes and fields are skipped, unknown control requests get an error reply, and malformed lines are ignored. The init message's `capabilities` list and version are kept in the state so features can be gated on them. Anything the panel cannot show (MCP elicitations, TUI-only commands such as `/login` or `/permissions`) goes through the hand-off: "Continue in terminal" stops the process and opens `claude --resume <id>` in a terminal panel through `POST /api/open`; "Resume here" starts the stream process again once the user has quit Claude there.

### Repository trust

Print mode skips Claude Code's own "trust this folder" prompt, so the project's hooks and settings would run unasked. The transport refuses to start in a repository Loxel does not trust and reports the restriction, which shows Loxel's trust prompt; the panel's "Resume here" starts it once trusted.

## Recordings

The transport is tested against recordings of the real CLI ([fixtures/](../src/server/agent/fixtures/)): NDJSON lines `{ dir: "out" | "in", frame }` captured from tiny Haiku sessions and scrubbed of paths, accounts and long lists. [stream-replay.ts](../src/server/agent/stream-replay.ts) plays one back: each frame the transport writes must match the next recorded `out` frame by type and subtype (or answer behavior), recorded request ids are renumbered to the transport's, and the `in` frames after it are fed in. A CLI change that alters the protocol shows up as a failing replay once a fresh recording is taken.

## Renderer

[src/components/agent/](../src/components/agent/):

- `useAgentSession`: the socket, reconnect with `sinceSeq` and `instanceId`, and `resumeSessionId`.
- `AgentPanel`: lays out the transcript and the composer, keeps `sessionId` in the panel params and the status in [agent-status.ts](../src/store/agent-status.ts) for [agent-tab.tsx](../src/components/dockview/agent-tab.tsx), and runs the hand-off.
- `AgentTranscript`: groups consecutive tool calls and thinking ([agent-activity.ts](../src/components/agent/agent-activity.ts), pure and tested) into one summary line on a rail; entries open file paths in the editor, show Bash commands with collapsed output and edits as diffs in the diff colours; subagent items nest under their Task call. Pending requests render through `renderRequest` at the call that asked.
- `AgentRequestCard`: the permission, question and plan cards, the only raised surfaces, with numbered shortcuts that work only once the card has focus.
- `AgentComposer` and `AgentControls`: one surface whose footer holds the model, effort and mode pill menus (`dropdown-menu`), the status line above it, and the `/` command list (wrapping arrows, Home/End, Page Up/Down, kept in view).
- `AgentMarkdown`: messages in Inter at 15/26 with the editor's proportions ([agent-transcript.css](../src/styles/agent-transcript.css)) and Shiki code blocks in the read-only code theme.
