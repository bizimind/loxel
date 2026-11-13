# Agent panel

The agent panel is a native view of a Claude Code session: the transcript, the cards for what the agent needs from the user, and a composer, instead of the `claude` TUI in a terminal. The server drives the agent; the renderer only shows a session's state and sends the user's actions.

## Layers

- **Model** ([agent-session-model.ts](../src/api/agent-session-model.ts)): what a session shows (`AgentSnapshot`: status, `AgentSessionInfo`, `TranscriptItem`s, pending `AgentInteraction`s), the `/ws/agent` messages in both directions, and `applyAgentMessage`, the pure reducer both sides apply server messages with. Nothing in it depends on how the server talks to the agent.
- **Session** ([agent-session.ts](../src/server/agent/agent-session.ts)): one per panel, keyed by the panel's `agentId`. It owns the snapshot, sends every attached socket a snapshot on attach and incremental messages after, turns tool requests into interactions and waits for the user's answer, derives the status, and hands the session off to a terminal and back.
- **Transport** ([agent-transport.ts](../src/server/agent/agent-transport.ts)): the boundary to the agent process. `AgentBackend.start` returns an `AgentTransport` (send, interrupt, model, effort, permission mode, close) and reports through an `AgentTransportSink` (updates, tool requests, exit). [claude-sdk-transport.ts](../src/server/agent/claude-sdk-transport.ts) implements it with the Claude Agent SDK.
- **Claude protocol mapping**, pure and transport-independent: [claude-message-translator.ts](../src/server/agent/claude-message-translator.ts) turns stream-json messages (what the SDK yields, and what `claude -p --output-format stream-json` prints) into `AgentUpdate`s; [claude-permissions.ts](../src/server/agent/claude-permissions.ts) maps a `can_use_tool` request to an interaction and the user's answer back to a permission result.
- **Sockets** ([agent-manager.ts](../src/server/agent/agent-manager.ts)): `/ws/agent` carries one panel's session. Its first message, `attach`, binds the socket to the session for `agentId`, creating it (and resuming `resumeSessionId`) when the server has none; every message is validated with zod. Closing the panel sends `agent_close` on the app socket from `CenterHost`, which skips layout swaps, so switching worktrees keeps the session running.
- **Renderer** ([components/agent/](../src/components/agent/)): `useAgentSession` keeps the socket, reconnecting with backoff, and the snapshot; `AgentPanel` lays out the header, `AgentTranscript`, `AgentInteractionCard`s and `AgentComposer`; the tab ([agent-tab.tsx](../src/components/dockview/agent-tab.tsx)) shows the status from `useAgentStatusStore`.

## Driving Claude Code

The SDK transport runs one streaming `query()` per session, so the process, its MCP servers and its caches live as long as the session. It spawns the user's own `claude`, found on the login-shell PATH like other user tools, with the user's settings, CLAUDE.md, skills, plugins and MCP servers (the SDK's default setting sources). Three options are what make it behave like the TUI:

- `systemPrompt: { type: "preset", preset: "claude_code" }`: without it the SDK sends an empty system prompt.
- `canUseTool`: without a handler, AskUserQuestion, EnterPlanMode and ExitPlanMode are left out of the toolset. Every tool request that needs the user, questions and plan approval included, arrives here.
- `extraArgs: { "replay-user-messages": null }`: the CLI echoes each user message as it takes it in, which is how a message queued while the agent works is marked delivered.

Interactions resolve as the TUI does:

- **AskUserQuestion**: the answers go back as the tool's updated input (`answers`, keyed by question text; multi-select labels joined with ", "). Skipping denies the tool call.
- **ExitPlanMode**: approving allows the call with a `setMode` permission update for the chosen mode, so the agent leaves plan mode in the same turn. "Keep planning" denies it with the user's feedback, and the agent revises the plan.
- **Permissions**: "Always allow" sends one of the agent's own suggestions back as an updated permission, saved where the user picks (session, local, project or user settings). Deny carries the user's feedback and can also stop the turn.

An interrupt aborts the pending tool requests, whose cards are withdrawn; the process keeps running.

## Lifetime

The panel's params persist `sessionId`, the agent's own session id. When the server has no session for a panel (after a restart), the attach resumes `sessionId` and rebuilds the transcript from the saved session (`getSessionMessages`). The agent process is a child of the server, so a server restart or update ends it; hosting it in the terminal host would let it survive the way terminals do.

"Continue in terminal" closes the query and opens a Loxel terminal running `claude --resume <sessionId>`, for anything the panel does not cover. "Resume here" starts the session again from what happened there. Each start bumps the session's generation, and a transport from an earlier generation can no longer report into it.

## Testing

[claude-message-translator.test.ts](../src/server/agent/claude-message-translator.test.ts) replays a real recorded session ([fixtures/claude-sdk-session.ndjson](../src/server/agent/fixtures/claude-sdk-session.ndjson)) through the translator. [scripts/record-agent-fixture.ts](../scripts/record-agent-fixture.ts) records a new one against the installed CLI, with Haiku in a scratch directory, and strips paths and the user's setup from it. Session behavior is tested with a fake backend ([agent-session.test.ts](../src/server/agent/agent-session.test.ts)).
