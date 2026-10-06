# Coding agent integration

How loxel hosts `@bizimind/coding-agent` sessions in the Bun server and renders them in agent panels, from WebSocket wiring to rewind, fork, devtools, and model settings.

The agent runtime, its tools, protocol, and on-disk session store are documented in [coding-agent README](../../coding-agent/README.md) and [SPEC.md](../../coding-agent/docs/SPEC.md). This doc only covers the loxel side. For the WebSocket server as a whole see [SHARED_SERVER.md](./SHARED_SERVER.md) and [ARCHITECTURE.md](./ARCHITECTURE.md); for panel hosting see [PANELS_AND_LAYOUT.md](./PANELS_AND_LAYOUT.md).

## Overview

```
CodingAgentPanel (renderer)            server.ts                AgentManager            Session (coding-agent SDK)
  agent_create / agent_request  ──WS──▶ agentOwners map ──────▶ sessions map ─────────▶ in-process runtime
  store.processEvent(seq)       ◀──WS── agent_event{id,seq} ◀── handleEvent (buffer) ◀── typed SessionEventHandlers
```

The agent runs in-process in the loxel server: [agent-manager.ts](../src/server/agent-manager.ts) calls `Session.create` / `Session.resume` from the SDK and never spawns a subprocess. Typed `SessionEvent`s are converted back into snake_case `AgentEventPayload` objects so the renderer's pure reducer, `processProtocolEvent` in [coding-agent-model.ts](../src/api/coding-agent-model.ts), can consume them. The `AgentEventPayload` doc comment in [ws-protocol.ts](../src/api/ws-protocol.ts) still says "forwarded from the coding-agent subprocess"; that wording predates the in-process `Session` API.

## Identity and keys

- **Loxel session id** (`id` in every `agent_*` message): a UUID minted by the renderer in `createAgent` / `openForkedAgent` ([panel-creators.ts](../src/lib/panel-creators.ts)). The dockview panel id is `agent-<id>` and the panel params carry `{ sessionId, worktreePath, forkedSessionId?, forkPointMessageId? }`. This is the registry key in `AgentManager.sessions` and in both renderer stores.
- **Coding-agent session id** (`codingAgentSessionId`): the SDK's persisted session id, learned from `session.started` / `session.resumed` / `session.rewound`. Renderer requests carry it as `session_id`, but the manager ignores that field and routes purely by loxel id.
- **Scope key**: the panel's worktree path (or `"default"`). `AgentManager.scopeIndex` maps scope to ids and backs `agent_list`, but no renderer code currently sends `agent_list` (the `agent_sessions` reply is a no-op in [ws-bridge.ts](../src/queries/ws-bridge.ts)).
- **Workspace root**: the panel's worktree path (or `"."`), passed as `SessionConfig.workspaceRoot`.

## Server: `AgentManager`

`AgentManager` owns one `AgentSession` record per loxel id: the resolved `Session` (or the pending `sessionReady` promise), an `AbortController` for the in-flight `send`, `respondCallbacks` for pending approvals and questions, the event buffer, derived `status`, and the mutable `onEvent` / `onExit` callbacks of the currently attached client.

### WS messages

Client to server (`WsClientMessage` in [ws-protocol.ts](../src/api/ws-protocol.ts), handled in `handleJsonMessage` in [server.ts](../src/server/server.ts)):

| Message                                                                                                | Server behavior                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_create { id, scopeKey, workspaceRoot, sessionOptions?, forkedSessionId?, forkPointMessageId? }` | Claims ownership in `agentOwners` (detaching any previous owner socket), then one of three paths: `reconnectClient` if the id exists, else `createFromFork` if `forkedSessionId` is set, else `create`. Always replies `agent_replay_done` synchronously. |
| `agent_request { id, request }`                                                                        | Owner-only. `sendRequest` validates `request` with the SDK's `protocolRequestSchema` and dispatches on `type`. Replies `agent_error` if the session is missing, exited, or the request is invalid.                                                        |
| `agent_detach { id }`                                                                                  | Owner-only. Clears callbacks; the session keeps running and buffering.                                                                                                                                                                                    |
| `agent_destroy { id }`                                                                                 | Owner-only. Aborts, destroys the `Session`, emits `agent_exit`. No renderer code sends it today.                                                                                                                                                          |
| `agent_list { scopeKey }`                                                                              | Replies `agent_sessions` with `{ id, status, codingAgentSessionId }[]`.                                                                                                                                                                                   |

Server to client: `agent_event { id, seq, event }`, `agent_exit { id, exitCode }`, `agent_replay_done { id }`, `agent_error { id, message }`.

`sendRequest` mapping: `session.input` takes `messages[0].content` and calls `session.send(content, { signal, modelProfile })` with a fresh `AbortController`; `session.cancel` aborts it; `session.compact` → `session.compact()`; `session.resume` with `rewind_to_message_id` aborts the run, clears `respondCallbacks`, and calls `session.rewind()` (without `rewind_to_message_id` it does nothing); `session.fork` → `session.fork(message_id)`, synthesizes a `session.forked` event for the client, then destroys the forked `Session` object (the fork stays persisted on disk); `session.get` → `session.getRecord()`, which emits `session.got`; `approval.response` / `human.input.response` look up `respondCallbacks` by `pending_key`. `session.start`, `session.close`, and `session.list` are accepted no-ops.

### Session config and models

`buildSessionConfig` passes `workspaceRoot`, `models`, `mode`, `profile`, and `declaredTools` from `sessionOptions`, a child logger, the handler table, and `env: buildSpawnEnv()` ([shell-env.ts](../src/server/shell-env.ts)), which is the server env with the resolved login-shell `PATH` and `~/.local/bin`. That env is only used for tool subprocesses. `AgentSessionOptions` is `Pick<SessionConfig, "models" | "mode" | "profile" | "declaredTools">`; `declaredTools` is never set by loxel today.

Options are read once, at creation. `reconnectClient` ignores the fresh `sessionOptions` the renderer sends on reattach, so changing settings does not affect running sessions.

### Lifecycle

- **Start**: mounting `CodingAgentPanel` sends `agent_create`. Creation is async; until `sessionReady` resolves, requests are chained on the promise. A failed create sets `hasError`, marks the session `exited`, and calls `onExit(id, 1)`, but leaves the record in the map.
- **Reattach**: on WS reconnect the panel re-sends `agent_create` with the same id. Since the center layout is persisted with panel params (see [STATE_AND_STORAGE.md](./STATE_AND_STORAGE.md)), a reloaded renderer does the same. `reconnectClient` replays the buffer synchronously, then swaps in the new callbacks.
- **Tab close**: [CenterHost.tsx](../src/components/dockview/CenterHost.tsx) sends `agent_detach` from `onDidRemovePanel` (skipped during layout swaps, so worktree switches neither detach nor destroy). Nothing can reattach to a closed tab's id, so the session runs until the server exits.
- **Client disconnect**: `detachClientAgents` detaches every session the socket owned. Detached sessions count as orphans in `hasOrphanSessions()`, which stretches idle shutdown from 30 s to the 5 min orphan grace period.
- **Server exit**: `shutdown()` calls `destroyAll()`.

### Event bridge and buffering

`buildHandlers` returns an exhaustive `SessionEventHandlers` record, so adding an event type to the SDK fails typecheck here. Each handler builds an `AgentEventPayload` and calls `handleEvent`, which:

1. Clears the buffer and resets `eventSeq` to 0 on `session.resumed` and `session.rewound`, so a later replay starts at the new branch rather than replaying a history that was rewound away.
2. Updates `status` via `deriveAgentStatus` (shared with the renderer in [ws-protocol.ts](../src/api/ws-protocol.ts)).
3. Appends `{ event, seq: ++eventSeq }` and evicts from the front while the buffer exceeds `MAX_EVENT_BUFFER` (5000).
4. Tracks `agent-event` in the [stress detector](../src/server/stress-detector.ts) and forwards to `onEvent` if attached.

`approval.requested` and `human.input.requested` store the SDK's `respond` closure under the event `key` before forwarding; the renderer echoes it back as `pending_key`. `error` events only set `hasError` and log; they are not forwarded.

Fields the bridge drops: `run.completed` always carries `message_id: ""` and no `metrics`, `tool.call.result` has no `message_id`, and `session.send` is called with content only, so the runtime's `message.received` reports `client_message_id: null`. The SDK's `SessionEvent` union has no `approval.granted`, `approval.denied`, or `human.input.response`, so those event types never reach the renderer even though the reducer and `deriveAgentStatus` handle them.

## Client

### Stores

[coding-agent.ts](../src/store/coding-agent.ts) is a global Zustand store keyed by loxel id, not scoped per worktree, so state survives worktree switches. It is not persisted. Per session it holds the timeline `items` (capped at `MAX_TIMELINE_ITEMS` = 2000), `lastSeq`, `status`, `codingAgentSessionId`, pending approval and human input, `messageIdMap`, `branchInfo` (a `SessionRecordSnapshot` from `session.got`), `queuedMessage`, and `todos`.

`processEvent` drops any event with `seq <= lastSeq`. This dedup is what makes full-buffer replay on reattach safe. It then runs the pure reducer `processProtocolEvent` and merges the result. When `session.got` arrives and the timeline is empty but the record has messages (a fresh fork tab, or after `clearTimeline`), it rebuilds items from the record's active chain via `rebuildTimelineFromRecord`, tagging each item with its server `messageId`.

### Panel wiring

[CodingAgentPanel.tsx](../src/components/coding-agent/CodingAgentPanel.tsx) owns the WS subscription for its id. It feeds `agent_event` into the store, opens a fork tab on `session.forked`, sends the queued message on `run.completed` / `run.failed` / `run.cancelled`, and sends `session.get` after `session.started` / `resumed` / `rewound` / `forked` to refresh `branchInfo`. Replayed events trigger these side effects too.

Rendering: [CodingAgentTimeline.tsx](../src/components/coding-agent/CodingAgentTimeline.tsx) switches on `item.kind`. `tool-call` and `tool-result` items render through [ToolUseCard.tsx](../src/components/coding-agent/ToolUseCard.tsx), which picks an icon per tool name and previews the input. A `tool.call.result` is merged into the `tool-call` item that has the same `tool_call_id`, or added as a standalone `tool-result`. `run.delta` and `run.reasoning` only append to the last item if it has the same kind, so text never merges across a tool call. Pending interactions render in [CodingAgentInteractionOverlay.tsx](../src/components/coding-agent/CodingAgentInteractionOverlay.tsx). Assistant markdown goes through [AgentMarkdown.tsx](../src/components/coding-agent/AgentMarkdown.tsx).

### Send, steer, queue

[CodingAgentInput.tsx](../src/components/coding-agent/CodingAgentInput.tsx) allows a plain send only in `ready` / `waiting`, and steer or queue only in `running`.

- **Send**: add an optimistic `user-<uuid>` item, then `session.input`.
- **Steer**: clear `queuedMessage`, send `session.cancel`, then immediately send `session.input`. On the server the abort makes the SDK reject the pending `send` synchronously, so the second `send` is not refused as "a run is already in progress"; the new run sees the work persisted so far.
- **Queue**: store-only (`setQueuedMessage`). The panel consumes it on the next terminal run event. Only one message can be queued, and a new one overwrites it.

### Status dots

`status` comes from `deriveAgentStatus(event.type)`, applied identically on server and client: `starting` → `ready` (session/run terminal and plan-mode events) / `running` (`run.started`) / `waiting` (approval or question requested); `agent_exit` sets `exited`. [coding-agent-tab.tsx](../src/components/dockview/coding-agent-tab.tsx) and [agent-devtools-tab.tsx](../src/components/dockview/agent-devtools-tab.tsx) each map that status to a dot color with duplicated inline logic.

## Rewind and fork

The SDK persists sessions as an append-only `events.jsonl` with branches and per-message snapshots (see the README's "Sessions, state, and permissions" section and SPEC "State Layout"). Loxel never stores conversation content itself, and the renderer store is in-memory only. Rewind and fork targets are server `SessionMessage` ids.

- **Rewind** (`rewindToMessage` + `handleRewind`): user items are exclusive (truncate before the item, rewind to the message's parent from `branchInfo`, put its text back in the input), other items are inclusive (rewind to the item's own `messageId`). The store resets `lastSeq` to 0 to match the server's seq reset on `session.rewound`.
- **Fork** (`handleFork`): same exclusive/inclusive target rule, sends `session.fork`. `openForkedAgent` opens a new tab whose params carry `forkedSessionId` and `forkPointMessageId` (deduped by `forkedSessionId`). That tab's `agent_create` goes through `createFromFork`: `Session.resume(forkedSessionId)` followed by `rewind(forkPointMessageId)`. Its timeline is rebuilt from `session.got`.
- **Fork tree** ([ForkTreePanel.tsx](../src/components/coding-agent/ForkTreePanel.tsx), sidebar panel `forkTree`): follows the active center agent panel via [useActiveAgentSession.ts](../src/hooks/useActiveAgentSession.ts) (matches the `agent-` panel id prefix and reads `params.sessionId`) and draws `branchInfo.branches` as an indented SVG tree. Selecting a branch, which is refused while the agent is `running`, calls `clearTimeline` and sends `session.resume` with `rewind_to_message_id` = that branch's head. The follow-up `session.got` then rebuilds the timeline for the new branch.

Unused code: `pendingFork`, `startFork`, `clearFork`, and [ForkToast.tsx](../src/components/coding-agent/ForkToast.tsx) are not referenced; forks always open a new tab.

## Agent devtools

[AgentDevToolsPanel.tsx](../src/components/agent-devtools/AgentDevToolsPanel.tsx) is a passive second subscriber to `agent_event` for one id; it never sends `agent_create`, so it only sees events that arrive after it mounts (or a later reattach replay). [agent-devtools.ts](../src/store/agent-devtools.ts) keeps raw events (cap `MAX_RAW_EVENTS` = 5000, mirroring the server buffer) with their own `lastSeq` dedup, plus the Events-tab type filter, search, and pause state. Paused sessions still advance `lastSeq`, so events received while paused are dropped, not deferred. The Metrics and State tabs are derived from `run.started`, `run.step.model.completed`, `run.completed.payload.metrics`, `context.compaction.completed`, and `debug.snapshot`. The in-process bridge emits only `run.started` and a metrics-less `run.completed`, so these tabs stay mostly empty. Closing the devtools tab removes its store entry (in `CenterHost`).

## Settings > Models

[ModelsSection.tsx](../src/components/settings/ModelsSection.tsx) / [ModelFormDialog.tsx](../src/components/settings/ModelFormDialog.tsx) edit the `models` library (`ModelEntry`: OpenRouter `modelId` + `apiKey`). [CodingAgentSection.tsx](../src/components/settings/CodingAgentSection.tsx) edits `codingAgent`: `baseModelId`, per-function `functionOverrides` (`planner`, `executor`, `fallback`, `judge`, `websearch`, `websearchFallback`), and `defaultMode` / `defaultProfile`. Both live in [settings-store.ts](../src/store/settings-store.ts).

`buildSessionOptions` resolves entry ids into `SessionConfig.models` (`base` plus one key per override, remapping `websearch` to `webSearch`), and adds `mode` / `profile`. It returns `{}` if the base entry is missing or its key failed to decrypt; in that case overrides are dropped too. Missing values then fall back to the SDK model router's environment variables (`OPENROUTER_API_KEY`, `OPENROUTER_MODEL_<PROFILE>`, `OPENROUTER_WEBSEARCH_MODEL`, ...; see the README "Configuration" table), read from the loxel server's `process.env`.

API keys are encrypted at rest by [routes.ts](../src/server/routes.ts) for store keys ending in `-settings` (AES-256-GCM, `enc:v1:` prefix) using [secret-store.ts](../src/server/secret-store.ts), whose key is loaded from the macOS Keychain at startup. Keys are decrypted on `GET /api/stores/:key`, so the renderer holds plaintext keys and sends them in `agent_create.sessionOptions`. A key that fails to decrypt becomes `{ err }` (`ApiKeyError`) and the UI flags it. Storage details: [STATE_AND_STORAGE.md](./STATE_AND_STORAGE.md).

## Invariants and gotchas

- **One `AgentSession` per loxel id, one owner socket per id.** `agent_create` for a live id always reattaches and never creates a second runtime; a new owner silently takes over from the previous one. Requests from non-owners are dropped.
- **Seq is per buffer epoch, not global.** It resets on `session.resumed` / `session.rewound`. The renderer must reset `lastSeq` whenever it expects that (it does so in `rewindToMessage` and `clearTimeline`); otherwise post-rewind events are deduped away. Devtools does not reset its `lastSeq`, so after a rewind it ignores events until seq passes its previous high-water mark.
- **Buffer cap.** Past 5000 events since the last resume/rewind, the oldest are evicted silently. A reattaching renderer with an empty store then replays a truncated timeline, with no marker.
- **Server restart (by code reading).** A non-fork panel's `agent_create` hits `create`, so it gets a brand-new SDK session rather than resuming the old one, and its seq restarts at 1 while the renderer's `lastSeq` is still high, so events are deduped until seq catches up. A fork tab instead re-resumes its persisted fork and rewinds to the fork point again.
- **Message-id correlation gap (by code reading).** Because the bridge drops client message ids and assistant/tool message ids (see "Event bridge"), live-streamed items have no `messageId`, and `messageIdMap` is only filled by `rebuildTimelineFromRecord`. For such items, rewind falls back to `session.resume` without a target (a server no-op that leaves the client in `starting`), and fork returns early. Rewind and fork work on timelines rebuilt from a session record. The panel comment "Message IDs are now resolved via message.received events" does not hold for the in-process path.
- **Pending interactions are never cleared by the server.** No `approval.granted` / `denied` / `human.input.response` events are emitted (see above), so `pendingApproval` / `pendingHumanInput` stay set until a rewind, `clearTimeline`, or the next request replaces them. Status does move on: the next `run.*` or `ready` event updates it.
- **Worktree removal.** No worktree removal path calls into `AgentManager`; sessions whose `workspaceRoot` was removed keep running until server exit. See [PROJECTS_AND_WORKTREES.md](./PROJECTS_AND_WORKTREES.md).
- **No tests.** There are no unit tests for `agent-manager.ts`, `coding-agent-model.ts`, or `store/coding-agent.ts`. When touching the manager, check by hand: create → reattach replay with no duplicates, steer during a run, an approval round-trip, rewind then reattach (buffer reset), fork into a new tab, closing a tab mid-run, and `bun test --cwd packages/coding-agent` for SDK-side `Session` changes.

## Where to look

- [src/server/agent-manager.ts](../src/server/agent-manager.ts): registry, `Session` bridge, buffer, request dispatch
- [src/server/server.ts](../src/server/server.ts): `agent_*` handlers, `agentOwners`, `detachClientAgents`, idle shutdown
- [src/api/ws-protocol.ts](../src/api/ws-protocol.ts): message shapes, `AgentSessionOptions`, `deriveAgentStatus`
- [src/api/coding-agent-model.ts](../src/api/coding-agent-model.ts): pure event → timeline reducer
- [src/store/coding-agent.ts](../src/store/coding-agent.ts), [src/store/agent-devtools.ts](../src/store/agent-devtools.ts): renderer state
- [src/components/coding-agent/](../src/components/coding-agent/), [src/components/agent-devtools/](../src/components/agent-devtools/): UI
- [src/lib/panel-creators.ts](../src/lib/panel-creators.ts): `createAgent`, `openForkedAgent`, `openAgentDevtools`
- [src/store/settings-store.ts](../src/store/settings-store.ts): `ModelEntry`, `CodingAgentSettings`, `buildSessionOptions`
