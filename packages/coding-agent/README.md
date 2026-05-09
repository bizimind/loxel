# coding-agent

`coding-agent` is a programmatic, event-sourced coding agent runtime for newline-delimited JSON protocols over stdio.

- No TUI assumptions.
- CLI and SDK use the same runtime core.
- Session reconstruction is strict and event-driven (`events.jsonl` is canonical).

Source of truth: [`./src/index.ts`](./src/index.ts)

## Install and run

From repo root:

```bash
bun install
bun run --cwd packages/coding-agent dev
```

The server reads one JSON request per line from stdin and emits one JSON event per line to stdout.

Source of truth: [`./src/cli.ts`](./src/cli.ts)

## CLI commands

- `coding-agent agent run`: start JSON-stream protocol server.
- `coding-agent session list`: list known sessions.
- `coding-agent session get --session-id <id>`: inspect one session.
- `coding-agent session resume --session-id <id> [--message-id <id>]`: resume, optionally rewind to a message id.
- `coding-agent session fork --session-id <id> [--message-id <id>]`: fork into a new session id.
- `coding-agent session compact --session-id <id>`: compact active context.

Source of truth: [`./src/cli.ts`](./src/cli.ts)

## Quickstart (CLI protocol)

### 1) Start a session

```json protocol-request
{
  "type": "session.start",
  "request_id": "req_start_1",
  "workspace_root": "/tmp/workspace",
  "profile": "execute",
  "declared_tools": ["Read", "Write", "ToolSearch"]
}
```

```json protocol-event
{
  "type": "session.started",
  "request_id": "req_start_1",
  "session_id": "session_demo_1",
  "timestamp": "2026-02-19T18:00:00.000Z",
  "payload": {
    "session_id": "session_demo_1",
    "mode": "execute",
    "profile": "execute",
    "plan_file_path": null,
    "declared_tools": ["Read", "Write", "ToolSearch"]
  }
}
```

### 2) Send user input

```json protocol-request
{
  "type": "session.input",
  "request_id": "req_input_1",
  "session_id": "session_demo_1",
  "messages": [{ "role": "user", "content": "Read package.json and summarize scripts" }],
  "model_profile": "executor"
}
```

```json protocol-event
{
  "type": "run.started",
  "request_id": "req_input_1",
  "session_id": "session_demo_1",
  "run_id": "run_demo_1",
  "timestamp": "2026-02-19T18:00:05.000Z",
  "payload": { "model_profile": "executor" }
}
```

### 3) Answer a human question (if requested)

```json protocol-request
{
  "type": "human.input.response",
  "request_id": "req_human_1",
  "session_id": "session_demo_1",
  "run_id": "run_demo_1",
  "pending_key": "run_demo_1:question:evt_123",
  "answers": { "scope": ["scripts only"] },
  "freeform": { "scope": "No dependency changes" }
}
```

### 4) Answer an approval request (if requested)

```json protocol-request
{
  "type": "approval.response",
  "request_id": "req_approval_1",
  "session_id": "session_demo_1",
  "run_id": "run_demo_1",
  "pending_key": "run_demo_1:approval:evt_456",
  "tool_name": "Write",
  "decision": "allow_this_session"
}
```

Note: invalid/unknown inbound lines are surfaced by the CLI host as `run.failed` events with `session_id: "unknown"`.

Source of truth:

- [`./src/protocol/schemas.ts`](./src/protocol/schemas.ts)
- [`./src/cli.ts`](./src/cli.ts)

## Protocol reference (concise)

Supported request types:

- `session.start`
- `session.input`
- `session.cancel`
- `session.close`
- `session.resume`
- `session.compact`
- `session.fork`
- `session.list`
- `session.get`
- `human.input.response`
- `approval.response`

Important event families:

- Session lifecycle: `session.started`, `session.resumed`, `session.rewound`, `session.forked`, `session.listed`, `session.got`
- Run lifecycle: `run.started`, `run.completed`, `run.failed`, `run.cancelled`
- Tooling/human approval: `tool.call.requested`, `tool.call.result`, `human.input.requested`, `human.input.response`, `approval.requested`, `approval.granted`, `approval.denied`
- Planning/context: `plan.*`, `context.compaction.*`
- Diagnostics: `runtime.warning`, `runtime.error`

Source of truth:

- [`./src/protocol/schemas.ts`](./src/protocol/schemas.ts)
- [`./src/orchestrator/runtime.ts`](./src/orchestrator/runtime.ts)

## SDK usage

```ts
import {
  CodingAgentRuntime,
  SessionStore,
  type ProtocolEvent,
  type ProtocolRequest,
} from "coding-agent";

const events: ProtocolEvent[] = [];
const runtime = new CodingAgentRuntime({
  emit: async (event) => {
    events.push(event);
  },
});

runtime.on("error", (diagnostic) => {
  console.error("runtime diagnostic", diagnostic.code, diagnostic.message);
});

const startReq: ProtocolRequest = {
  type: "session.start",
  request_id: "req_sdk_start",
  workspace_root: process.cwd(),
  profile: "execute",
};
await runtime.handleRequest(startReq);

const started = events.find((event) => event.type === "session.started");
const sessionId = String(started?.payload.session_id ?? "");

await runtime.handleRequest({
  type: "session.input",
  request_id: "req_sdk_input",
  session_id: sessionId,
  messages: [{ role: "user", content: "Run ToolSearch for read tools" }],
});

// Direct session operations (without protocol server)
const store = new SessionStore();
const summary = await store.listSessions();
const active = await store.loadSession(sessionId);
const forked = await store.fork(sessionId);
const compacted = await store.compact(sessionId);
```

Source of truth: [`./src/index.ts`](./src/index.ts)

## Tools and profiles

Canonical tools:

- File operations: `Read`, `Edit`, `Write`, `MultiEdit`
- Search/discovery: `Glob`, `Grep`, `ToolSearch`
- Command/task: `Bash`, `Task`, `TaskOutput`, `TaskStop`
- Web: `WebFetch`, `WebSearch`
- Human/plan/todo: `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `TodoWrite`, `TodoRead`
- Extensions: `Skill`

Profiles:

- `execute`: full tool set (subject to permissions and declared tools).
- `plan`: no execution shell; read/search everywhere; write/edit limited to plan file path policy.
- `minimal`: restricted read/search + ask-user oriented set.

Aliases accepted on input:

- `WriteTodo` -> `TodoWrite`
- `ReadTodo` -> `TodoRead`
- `ShellOutput` -> `TaskOutput`
- `BashOutput` -> `TaskOutput`
- `KillShell` -> `TaskStop`

Declared tools:

- If `declared_tools` is provided at `session.start`, runtime intersects profile tools with declared capabilities.

Source of truth:

- [`./src/tools/schemas.ts`](./src/tools/schemas.ts)
- [`./src/tools/profile.ts`](./src/tools/profile.ts)
- [`./src/tools/capabilities.ts`](./src/tools/capabilities.ts)
- [`./src/tools/tool-names.ts`](./src/tools/tool-names.ts)

## Session and state behavior

Guarantees:

- `events.jsonl` is the strict source of truth for session reconstruction.
- Replay is strict; malformed JSONL/event payloads fail reconstruction.
- `rewind` creates a branch and restores agent-controlled state at target message.
- `fork` clones full source event timeline into a new `sessionId`.
- `compact` does summarize+replace for active context while preserving full rewindable history.
- Plan files are global under state root `/plans` (outside workspace).

Default state root:

- `~/.local/state/loxel/coding-agent/`

Layout (high-level):

- `settings.json`
- `permissions/project/*.json`
- `permissions/session/*.json`
- `plans/*.md`
- `sessions/<sessionId>/events.jsonl`
- `sessions/<sessionId>/artifacts/*`

Source of truth:

- [`./src/session/store.ts`](./src/session/store.ts)
- [`./src/state/layout.ts`](./src/state/layout.ts)

## Permissions and approval semantics

Approval decisions:

- `allow`
- `allow_this_session`
- `allow_always`
- `deny`

Persistence behavior:

- `allow` and `deny`: not persisted.
- `allow_this_session`: persisted in session permission file.
- `allow_always`: persisted in project permission file.

Source of truth:

- [`./src/permissions/model.ts`](./src/permissions/model.ts)
- [`./src/permissions/store.ts`](./src/permissions/store.ts)

## Configuration (environment variables)

| Variable                              | Required              | Default                             | Effect                                                      |
| ------------------------------------- | --------------------- | ----------------------------------- | ----------------------------------------------------------- |
| `OPENROUTER_API_KEY`                  | Yes (model/web calls) | none                                | OpenRouter auth for model routing and WebSearch.            |
| `OPENROUTER_MODEL_PLANNER`            | No                    | `z-ai/glm-5`                        | Planner profile model id.                                   |
| `OPENROUTER_MODEL_EXECUTOR`           | No                    | `moonshotai/kimi-k2.5`              | Executor profile model id.                                  |
| `OPENROUTER_MODEL_FALLBACK`           | No                    | `openrouter/auto`                   | Fallback profile model id.                                  |
| `OPENROUTER_WEBSEARCH_MODEL`          | Yes (WebSearch)       | none                                | Primary model for web plugin search calls.                  |
| `OPENROUTER_WEBSEARCH_FALLBACK_MODEL` | No                    | none                                | Secondary WebSearch model if primary fails.                 |
| `CODING_AGENT_STATE_ROOT`             | No                    | `~/.local/state/loxel/coding-agent` | Override persisted state root.                              |
| `CODING_AGENT_COST_INPUT_USD_PER_M`   | No                    | none                                | Optional per-million input token cost for usage estimates.  |
| `CODING_AGENT_COST_OUTPUT_USD_PER_M`  | No                    | none                                | Optional per-million output token cost for usage estimates. |

Source of truth:

- [`./src/orchestrator/model-router.ts`](./src/orchestrator/model-router.ts)
- [`./src/tools/handlers.ts`](./src/tools/handlers.ts)
- [`./src/state/layout.ts`](./src/state/layout.ts)
- [`./src/orchestrator/loop.ts`](./src/orchestrator/loop.ts)

## Operational limits and safety notes

| Area       | Limit summary                                                          |
| ---------- | ---------------------------------------------------------------------- |
| Read       | max window 2000 lines, max line length 2000 chars, max 50 KiB payload  |
| Grep       | default 100 matches, hard max 2000                                     |
| Bash       | default timeout 120s, max 600s, preview truncation 2000 lines / 50 KiB |
| TaskOutput | default blocking with 30s timeout, max 600s                            |
| Web        | fetch timeout 30s, search default top 8, max top 20                    |

Notes:

- Outputs may be truncated with artifact references for full content retrieval.
- Approval policy can block tool execution even when tool is in profile.

Source of truth: [`./src/core/constants.ts`](./src/core/constants.ts)

## Troubleshooting

Missing OpenRouter config:

- Symptom: provider/model errors or `WEBSEARCH_UNAVAILABLE`.
- Check required env vars in configuration section.

Malformed protocol request:

- Symptom: `run.failed` event from CLI host with parse/validation error.
- Validate request against `protocolRequestSchema`.

Strict replay failure:

- Symptom: `session.get`, `session.list`, or `session.resume` fails due to malformed/corrupt `events.jsonl`.
- Inspect state root `sessions/<id>/events.jsonl`.

Approval/tool availability issues:

- Symptom: tool denied or unavailable errors.
- Check profile gating, `declared_tools`, and persisted permissions.

Runtime diagnostics:

- Subscribe via `runtime.on("error", ...)` in SDK mode.
- Monitor emitted `runtime.error`/`runtime.warning` events.

Source of truth:

- [`./src/protocol/schemas.ts`](./src/protocol/schemas.ts)
- [`./src/orchestrator/runtime.ts`](./src/orchestrator/runtime.ts)
- [`./src/session/store.ts`](./src/session/store.ts)
- [`./src/permissions/store.ts`](./src/permissions/store.ts)
