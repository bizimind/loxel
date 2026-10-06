# coding-agent

`@bizimind/coding-agent` is a programmatic, event-sourced coding agent runtime. It runs tool-calling agent loops against OpenRouter models, with plan mode, human questions, approval gates, and persistent sessions that can be resumed, rewound, forked, and compacted. There is no TUI: hosts drive it either in-process through the SDK or as a subprocess speaking newline-delimited JSON over stdio. The loxel app's Coding Agent panel uses the in-process `Session` API.

- CLI and SDK share the same runtime core.
- Each session's `events.jsonl` is the source of truth; session state is rebuilt by strict replay of that log.

Further docs:

- [Design spec](./docs/SPEC.md): protocol, tool contracts, plan mode, approvals, prompt layering, agent loop, and session semantics, with rationale.

## Install and run

From the repo root:

```bash
pnpm install
bun packages/coding-agent/src/cli.ts agent run      # start the stdio JSON protocol server
pnpm -C packages/coding-agent run build             # standalone binary at dist/coding-agent
```

The protocol server reads one JSON request per line from stdin and writes one JSON event per line to stdout.

## CLI commands

- `coding-agent agent run [--no-log]`: start the stdio JSON protocol server. Logs go to Axiom when `AXIOM_TOKEN` and `AXIOM_DATASET` are set (never to stdout); `--no-log` disables logging.
- `coding-agent session list`: list known sessions.
- `coding-agent session get --session-id <id>`: inspect one session.
- `coding-agent session resume --session-id <id> [--message-id <id>]`: load a session, optionally rewinding to a message.
- `coding-agent session fork --session-id <id> [--message-id <id>]`: fork into a new session, optionally at a message.
- `coding-agent session compact --session-id <id>`: compact the active context.

The `session` commands accept `-j, --json` for JSON output.

Source of truth: [`./src/cli.ts`](./src/cli.ts)

## SDK

The package root exports the runtime. [`./src/index.ts`](./src/index.ts) lists the full public surface.

- `Session`: the recommended in-process API. `Session.create(config)` and `Session.resume(id, config)` return a session with `send()` (resolves with `{ messageId, runId, text }` when the run completes, accepts an `AbortSignal`), `rewind()`, `fork()`, `compact()`, and `destroy()`. `config.handlers` must name a handler (or `null`) for every event type. `withAutoApprove()` fills in the rest and auto-allows approvals.
- `CodingAgentSession` / `CodingAgentRuntime`: lower-level wrappers that take raw protocol requests and emit raw protocol events. Use them for protocol bridges.
- `SessionStore`, `PermissionStore`, tool schemas and registry, and loop-control helpers are exported for direct use.

```ts
import { Session, withAutoApprove } from "@bizimind/coding-agent";

const session = await Session.create({
  workspaceRoot: process.cwd(),
  profile: "execute",
  handlers: withAutoApprove({ "run.delta": (event) => process.stdout.write(event.text) }),
});

const result = await session.send("Read package.json and summarize scripts");
session.destroy();
```

`@bizimind/coding-agent/schemas` ([`./src/schemas.ts`](./src/schemas.ts)) exports only Zod schemas and types with no Node.js dependencies, so browser builds can import it.

Source of truth: [`./src/session/session-types.ts`](./src/session/session-types.ts), [`./src/sdk.ts`](./src/sdk.ts)

## Protocol (stdio JSON stream)

Requests: `session.start`, `session.input`, `session.cancel`, `session.close`, `session.resume`, `session.compact`, `session.fork`, `session.list`, `session.get`, `human.input.response`, `approval.response`.

Every event shares one envelope: `type`, `session_id`, `timestamp`, `payload`, plus optional `request_id` and `run_id`. The main event families are `session.*`, `run.*` (including `run.delta` and per-step `run.step.*`), `tool.call.*`, `human.input.*`, `approval.*`, `plan.*`, `context.compaction.*`, and `runtime.warning` / `runtime.error`. If an input line fails to parse or validate, the CLI emits a `run.failed` event with `session_id: "unknown"`.

Source of truth: [`./src/protocol/schemas.ts`](./src/protocol/schemas.ts), [`./src/orchestrator/runtime.ts`](./src/orchestrator/runtime.ts)

### Example exchange

Start a session:

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

Send user input:

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

Answer a human question (`human.input.requested`):

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

Answer an approval request (`approval.requested`):

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

## Tools and profiles

Tools use Claude Code's names and input shapes: `Read`, `Edit`, `Write`, `MultiEdit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `WebSearch`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `Task`, `TaskOutput`, `TaskStop`, `TodoWrite`, `TodoRead`, `ToolSearch`, `Skill`. Legacy names (`WriteTodo`, `ReadTodo`, `ShellOutput`, `BashOutput`, `KillShell`) are accepted as input aliases.

| Profile   | Tools                                                                                        |
| --------- | -------------------------------------------------------------------------------------------- |
| `execute` | Full catalog, subject to approvals                                                           |
| `plan`    | No `Bash`, `TodoWrite`, or `Skill`; `Edit`/`Write`/`MultiEdit` only on the session plan file |
| `minimal` | `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `AskUserQuestion`, `ToolSearch`, `TodoRead` |

If `session.start` includes `declared_tools`, the session only exposes tools that are both in the profile and in that list.

Source of truth: [`./src/tools/schemas.ts`](./src/tools/schemas.ts), [`./src/tools/profile.ts`](./src/tools/profile.ts), [`./src/tools/tool-names.ts`](./src/tools/tool-names.ts)

## Sessions, state, and permissions

State lives under `~/.local/state/loxel/coding-agent/` (override with `CODING_AGENT_STATE_ROOT`): `sessions/<id>/events.jsonl` plus artifacts, project and session permission files under `permissions/`, and plan files under `plans/` (kept outside the workspace). Replay is strict: a malformed `events.jsonl` makes `session.get`, `session.list`, and `session.resume` fail instead of skipping the bad entries.

- Rewind branches the history at a message and restores agent state (context, plan, todos, reminders) at that point. It does not undo filesystem side effects or permissions.
- Fork copies the full event timeline into a new session ID.
- Compact replaces the active context with a summary and keeps the full history available for rewind.

Approval decisions: `allow` and `deny` apply once, `allow_this_session` is saved to the session's permission file, and `allow_always` is saved to the project's permission file.

Source of truth: [`./src/session/store.ts`](./src/session/store.ts), [`./src/state/layout.ts`](./src/state/layout.ts), [`./src/permissions/store.ts`](./src/permissions/store.ts)

## Configuration

SDK hosts can pass models and API keys in `SessionConfig.models` / `CodingAgentSessionOptions.models`. Without them, the runtime reads these environment variables:

| Variable                              | Default                             | Effect                                                         |
| ------------------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| `OPENROUTER_API_KEY`                  | none (required)                     | OpenRouter auth for model calls and `WebSearch`.               |
| `OPENROUTER_MODEL_PLANNER`            | `z-ai/glm-5`                        | Planner profile model.                                         |
| `OPENROUTER_MODEL_EXECUTOR`           | `moonshotai/kimi-k2.5`              | Executor profile model.                                        |
| `OPENROUTER_MODEL_FALLBACK`           | `openrouter/auto`                   | Fallback profile model.                                        |
| `OPENROUTER_MODEL_JUDGE`              | `anthropic/claude-3-haiku`          | Model that checks whether a long run is still making progress. |
| `OPENROUTER_WEBSEARCH_MODEL`          | none (required for `WebSearch`)     | Model used for `WebSearch` (OpenRouter web plugin).            |
| `OPENROUTER_WEBSEARCH_FALLBACK_MODEL` | none                                | Model to retry `WebSearch` with if the primary model fails.    |
| `CODING_AGENT_STATE_ROOT`             | `~/.local/state/loxel/coding-agent` | Override the state root.                                       |
| `CODING_AGENT_COST_INPUT_USD_PER_M`   | none                                | Input token price used for cost estimates in `run.completed`.  |
| `CODING_AGENT_COST_OUTPUT_USD_PER_M`  | none                                | Output token price used for cost estimates in `run.completed`. |

Source of truth: [`./src/orchestrator/model-router.ts`](./src/orchestrator/model-router.ts)
