# `coding-agent` Specification (Programmatic-Only)

## Goal

Design a `coding-agent` package that provides Claude Code / Codex CLI-like capabilities for **programmatic integration** over **stdio JSON streaming** (no TUI requirements), with strong support for:

- Tool calling and tool orchestration
- Human interaction tools (ask/confirm/choice)
- Plan mode (structured planning + progress tracking)
- Approval gates for risky actions

Primary model routing is through **OpenRouter** using **Vercel AI SDK 6**, targeting **GLM-5** and **Kimi K2.5**.

## Non-Goals

- Building any terminal UI, chat UI, or editor plugin in this specification scope
- Implementing full autonomous project management features beyond planning and execution loops
- Hard-coding to a single model/provider

## Tech Constraints

- Runtime: TypeScript + Bun
- Model SDK: Vercel AI SDK 6
- Validation: Zod 4
- Provider: OpenRouter (model aliases/configurable fallbacks)
- Transport: stdio JSON stream (newline-delimited JSON events)

## CLI Integration (Monorepo-Aligned)

Programmatic runtime is primary; CLI is a thin host on top of the same orchestrator.

The CLI implementation MUST use `packages/cli-common` for shared behavior:

- `runAction` / `runActionSync` + `CommandResult` for consistent command execution/results.
- `agent run` uses newline-delimited JSON streaming as the default and only mode (no `--json-stream` flag).
- shared formatter utilities (`formatTable`, `formatKeyValue`, `formatStatus`) may still be used by non-agent utility commands.
- shared error wrapping/logging (`wrapError`, logging helpers) for deterministic exit behavior.

CLI command surface (no TUI assumptions):

- `agent run`
- `session resume --session-id <id> [--message-id <id>]`
- `session compact --session-id <id>`
- `session fork --session-id <id> [--message-id <id>]`
- `session list` / `session get`

## Protocol Design Principles

- Prefer **Vercel AI SDK native types** in the wire contract where possible, instead of inventing parallel message schemas.
- Keep custom modeling limited to what the SDK does not fully define for this use case:
  - tool input schemas
  - tool output schemas
  - session metadata/state
- Preserve API familiarity by reusing SDK naming and semantics for messages, tool calls, and tool results.
- Minimize adapters between host app and orchestrator.
- Use SDK-first typing approach:
  - conversation payloads use AI SDK message types directly
  - tool registry uses AI SDK tool contracts (`ToolSet`-style definitions)
  - stream events carry SDK-compatible tool-call and tool-result shapes
  - only session/event envelopes are custom

## Conformance Language

This specification uses RFC-style conformance keywords:

- `MUST` / `MUST NOT`: mandatory behavior.
- `SHOULD` / `SHOULD NOT`: recommended behavior with justified exceptions allowed.
- `MAY`: optional behavior.

## Product Surface (Programmatic Contract)

### 1) Session Lifecycle

The protocol MUST expose a stable session API over stdio:

- `session.start`
- `session.input` (user/developer/system messages)
- `session.cancel`
- `session.close`
- `session.resume` (supports optional rewind cursor)
- `session.compact` (manual compaction trigger)

Each request emits structured stream events:

- `run.started`
- `run.delta` (text/token and tool-intent deltas)
- `tool.call.requested`
- `tool.call.result`
- `plan.updated`
- `human.input.requested`
- `session.rewound`
- `context.compaction.started`
- `context.compaction.completed`
- `context.compaction.failed`
- `runtime.warning`
- `runtime.error`
- `run.completed`
- `run.failed`

### 2) Message Model

Use Vercel AI SDK message types directly (`CoreMessage`/SDK-equivalent in v6) as the canonical conversation format.

Include a thin envelope only for runtime metadata:

- correlation IDs / run IDs
- timestamps
- session ID
- model/provider info
- usage accounting

### 3) Tooling Core

Tool definitions include:

- `name`
- `description`
- `inputSchema` (Zod)
- `outputSchema` (Zod, optional but preferred)
- `requiresApproval` policy
- execution mode (`sync`, `streaming`, `long-running`)

Tool invocation contract:

- deterministic call ID
- validated arguments
- typed success/error envelopes
- timeout + retry policy hooks

DRY tool typing requirements:

- infer input/output TS types directly from Zod schemas (`z.infer`)
- no duplicate hand-written interfaces for tool args/results
- tool handlers callable directly from code (same typed function used by both orchestrator and tests)
- single source of truth: schema drives validation + runtime docs + compile-time types

### 3.1) Final Tool Catalog + Profiles (Claude-Aligned)

Unless explicitly marked as compatibility alias or optional extension, requirements in this section are `MUST`.

Final supported tool catalog (wire-level names):

- `Read`
- `Edit`
- `Write`
- `MultiEdit`
- `Glob`
- `Grep`
- `Bash`
- `WebFetch`
- `WebSearch`
- `AskUserQuestion`
- `EnterPlanMode`
- `ExitPlanMode`
- `Task`
- `TaskOutput`
- `TaskStop`
- `TodoWrite`
- `TodoRead`
- `ToolSearch`
- `Skill`

Explicitly out of scope:

- any `notebook_*`/`Notebook*` tool
- any `slash_command` tool

Compatibility requirements:

- use exact tool names on the wire (PascalCase)
- preserve Claude MCP required inputs exactly where defined
- support Claude behavior from tool descriptions/prompts (parallelism, plan transitions, approval semantics, web-source citation)
- runtime capability negotiation is required (do not assume one static MCP list is complete)
- keep host-facing aliases only as input compatibility shims, never in persisted logs

Name mapping compatibility (input only, persisted/canonical output always uses canonical names):

- `WriteTodo` -> `TodoWrite`
- `ReadTodo` -> `TodoRead`
- `ShellOutput` -> `TaskOutput`
- `BashOutput` -> `TaskOutput` (compat alias only)
- `KillShell` -> `TaskStop` (compat alias only)
- `LS` -> handled via `Glob("*")` fallback when no dedicated `LS` tool exists

Profile-based tool exposure:

- `execute` profile:
  - full catalog above (subject to permission policy)
- `plan` profile:
  - no project mutation tools
  - allow exploration tools (`Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `ToolSearch`, `Task`, `TodoRead`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`)
  - allow `Edit`/`Write`/`MultiEdit` only for the plan file path (hard path guard)
  - disallow `Bash` and all non-plan-file mutations
- `minimal` profile:
  - read/search + ask-user only, for restricted environments

Directory listing behavior:

- if a dedicated `LS` tool is not exposed, directory listing must use `Glob` with directory patterns (including `*` for current directory).

### 3.2) Tool Implementation Specification (Schema-Aligned)

Unless explicitly marked optional, requirements in this section are `MUST`.

Implementation principle across all tools:

- define each tool with AI SDK `tool({ description, inputSchema, execute, ... })`
- derive input/output types from Zod schema (`z.infer`)
- mirror MCP input/output fields for compatibility
- return compact, structured payloads optimized for model context efficiency

Token-efficiency and predictability rules:

- hard output caps with explicit `truncated=true` and actionable continuation hints.
- pagination-first for large outputs (`offset` + `limit`).
- line-numbered file content to reduce follow-up ambiguity.
- never require full-file rewrite for normal edits.
- deterministic field order and stable error codes.

Default limits (based on Claude/OpenCode/Codex behavior, tuned for low token waste):

- `Read`:
  - default window: 2000 lines
  - max line length: 2000 chars
  - max returned bytes per call: 50 KiB
- `Glob`:
  - max results: 100
- `Grep`:
  - default `head_limit`: 100
  - hard max returned entries: 2000
  - include truncation guidance to narrow pattern/path
- `Bash`:
  - default timeout: 120000ms
  - max timeout: 600000ms
  - output truncation target: 2000 lines or 50 KiB preview, with path to full captured output artifact
- `TaskOutput`:
  - default `block=true`, default timeout 30000ms, max timeout 600000ms
- `WebFetch`:
  - network timeout 30000ms
  - post-processed output cap aligned to tool truncation policy (50 KiB preview + artifact path)
- `WebSearch`:
  - default top results: 8
  - hard max results: 20

Tool contract simplification rules:

- each tool should have a small "happy path" signature with minimal required params.
- advanced behavior should be optional and rarely needed.
- avoid provider- or harness-specific knobs in core tool schemas unless required for parity.
- prefer semantically clear argument names over shell-flag mirroring when designing non-parity-native tools.

Safe self-correction policy (strictly limited):

- allow only low-risk corrections:
  - normalize relative paths into cwd/workspace context
  - suggest near-match file paths
  - auto-apply correction only when single high-confidence match and action is non-destructive
- destructive/mutating ambiguity must fail closed with guidance, not auto-correct

Validation + mapping + error behavior:

- parse raw tool request -> normalize aliases -> validate with strict Zod schema.
- unknown fields fail with `TOOL_VALIDATION_UNKNOWN_FIELD`.
- missing/invalid fields fail with `TOOL_VALIDATION_FAILED`.
- tool unavailable in current profile fails with `TOOL_NOT_IN_PROFILE`.
- declared-but-disabled tool fails with `TOOL_NOT_AVAILABLE`.
- permission rejection returns `TOOL_PERMISSION_DENIED`.
- guardrail violation (plan-mode mutation, path escape, etc.) returns `TOOL_POLICY_VIOLATION`.
- timeout returns `TOOL_TIMEOUT`.
- runtime failures return `TOOL_RUNTIME_ERROR`.
- every error envelope includes:
  - `code`
  - `message`
  - `retriable`
  - `suggested_fix` (short next action for the model)

Per-tool implementation notes (schema + behavior):

- `Bash`
  - implement `command`, optional `timeout`, optional `description`, optional `run_in_background`, optional `dangerouslyDisableSandbox`.
  - if `run_in_background=true`, create persistent task record and return `backgroundTaskId`.
  - output envelope mirrors Claude schema (`stdout`, `stderr`, `interrupted`, optional `structuredContent`, optional `backgroundTaskId`) with truncation metadata for large outputs.
- `TaskOutput`
  - implement required `task_id`, `block`, `timeout` exactly as MCP.
  - treat as generic output retrieval across task classes (subagent tasks, background shells, remote sessions).
- `TaskStop`
  - implement optional `task_id` and optional `shell_id` exactly.
  - route `task_id` to task manager stop and map `shell_id` for backward compatibility.
  - stopping background shell work must flow through this generic tool.
- `Task`
  - implement required `description`, `prompt`, `subagent_type`; support `resume`, `run_in_background`, `max_turns`, `mode`, `model`, `team_name`, `name`.
  - support parallel launch and resumable IDs.
  - subagent effective permissions must inherit parent/session scope:
    - child permissions = intersection(parent scope, child default scope)
    - child can never gain broader permissions than parent
    - in plan mode, child inherits plan-mode constraints
- `Read`
  - implement `file_path`, optional `offset`, optional `limit`.
  - return numbered lines and deterministic pagination hints (`next_offset`).
  - support file and directory reads when enabled; otherwise fail with typed error + guidance.
- `Edit`
  - implement simple find/replace mode only for now (`old_string`, `new_string`, optional `replace_all`).
  - enforce "read-before-edit" policy where configured.
- `MultiEdit`
  - batch of ordered find/replace edits applied atomically per file.
- `Write`
  - implement required `file_path`, `content`; return structured patch metadata.
- `Glob`
  - implement required `pattern`, optional `path`; sort by recency to match Claude behavior.
  - enforce result cap + truncation guidance.
- `Grep`
  - implement required `pattern`; support flags (`-A`, `-B`, `-C`, `-i`, `-n`) + `glob`, `type`, `output_mode`, `multiline`, `head_limit`, `offset`.
  - default to line-numbered compact snippets with explicit file/match counts and truncation hints.
- `WebFetch`
  - implement required `url`, `prompt`; enforce safe fetch limits and return typed status/bytes/duration fields.
- `WebSearch`
  - implement required `query`; optional `allowed_domains`, optional `blocked_domains`.
  - enforce source citation behavior in downstream answer policy.
- `TodoWrite`
  - implement required `todos[]` with `content`, `status`, `activeForm`; enforce max one `in_progress`.
- `TodoRead`
  - expose current todo state for parity and rewind state reconstruction.
- `AskUserQuestion`
  - implement required `questions`; enforce options, recommended-option-first convention, and `multiSelect` support.
- `EnterPlanMode`
  - no required inputs; transition to plan-mode collaboration policy.
- `ExitPlanMode`
  - no required inputs; support optional payload fields seen in MCP variants (`allowedPrompts`, `pushToRemote`, `remoteSession*`).
  - trigger plan-approval handshake and mode transition only after plan artifact is present and saved.
- `Skill`
  - implement required `skill`, optional `args`.
- `ToolSearch`
  - implement required `query` and `max_results`.
  - support keyword mode, required-keyword (`+`), and direct select (`select:<tool>`) with "loaded-on-return" semantics.

Optional compatibility aliases (only when needed for external parity surfaces):

- `BashOutput` delegates to `TaskOutput`.
- `KillShell` delegates to `TaskStop`.

### 3.3) `WebSearch` Backend Specification (OpenRouter + Vercel AI SDK 6)

Primary backend decision:

- use OpenRouter web plugin via AI SDK provider options (`plugins: [{ id: "web" }]`) in a dedicated web-search model call.
- keep this OpenRouter-first; no mandatory external search vendor in phase 1.

Execution flow:

1. Normalize the user query for recency-sensitive intents (inject current year when intent is "latest/recent/current").
2. Apply domain constraints:
   - `allowed_domains` -> add `site:` query constraints + post-filter URL hosts.
   - `blocked_domains` -> add `-site:` query constraints + post-filter URL hosts.
3. Run model call in structured-output mode and normalize to MCP output:
   - `{ query, results: [{ title, url, snippet }], durationSeconds }`.
4. If current model rejects web plugin, retry with configurable OpenRouter fallback model profile dedicated to web search.
5. If still unavailable, return typed recoverable tool error (`WEBSEARCH_UNAVAILABLE`) with actionable fallback guidance.

Policy requirements:

- enforce mandatory final response `Sources:` section with markdown links.
- retain raw URLs in tool metadata for deterministic downstream citation rendering.

### 3.4) AI SDK v6 + Zod 4 Integration Decisions

Core runtime decisions (SDK-native first):

- use AI SDK v6 `generateText` / `streamText` for the core orchestration loop.
- use `ToolLoopAgent` for reusable subagents where shared defaults are beneficial; keep primary orchestrator loop explicit for protocol/event control.
- use `tool(...)` definitions as the canonical runtime tool contract.
- use `ModelMessage`-style SDK message types directly in session state and wire payloads wherever possible.

Loop control decisions:

- explicit `stopWhen` policy per run (do not rely on hidden defaults), with hard cap and optional sentinel-based stop conditions (`hasToolCall` for finalization tools).
- use step-level hooks (`prepareStep` / step callbacks) for dynamic tool/model shaping and policy injection.
- support approval-gated tools through SDK `needsApproval` semantics, mapped into protocol `approval.*` events.

Schema decisions (Zod 4):

- author tool schemas in Zod 4 and derive TypeScript types from schemas only.
- generate JSON Schema via `z.toJSONSchema(...)` where raw schemas are needed (transport/docs/provider compatibility).
- set JSON Schema conversion behavior explicitly:
  - `target`: default `draft-2020-12` unless downstream requires otherwise.
  - `unrepresentable`: default `"throw"` in CI checks, optionally `"any"` only for controlled compatibility fallback.
  - `cycles` / `reused`: use deterministic settings to avoid unstable schema output between runs.
- avoid `z.fromJSONSchema()` as a core dependency path (documented experimental API); use only behind explicit compatibility adapters.

Provider integration decisions:

- OpenRouter is primary model transport.
- prefer dedicated provider package when available (`@openrouter/ai-sdk-provider`); keep OpenAI-compatible base URL adapter as fallback.
- pass provider-specific options through SDK provider option fields; avoid custom ad-hoc transport fields.
- web search behavior is abstracted behind `WebSearch` tool contract, with provider/plugin differences normalized in adapter layer.

Middleware decisions:

- use AI SDK language-model middleware for cross-cutting concerns:
  - telemetry and trace tags
  - prompt segment diagnostics (dev only)
  - redaction/safety preflight
  - provider fallback instrumentation

### 4) Human Interaction Tools

Primary user-interaction tool on wire:

- `AskUserQuestion` for structured, multi-question, option-based interaction during planning/execution.

Host-side interaction primitives (protocol-level, UI-agnostic):

- `human.input.requested` with typed payload (`question`, `options`, `multiSelect`, `metadata`)
- `human.input.response` with selected option IDs + optional freeform text
- `human.input.timeout`
- `human.input.rejected`

Approval events remain separate from general Q&A:

- `approval.requested` (summary, command/tool payload, risk reason, scope)
- `approval.granted`
- `approval.denied`

### 5) Plan Mode

All rules in this section are `MUST` unless explicitly marked otherwise.

Plan mode is a controlled collaboration mode with explicit enter/exit tools:

- `EnterPlanMode` is used proactively for non-trivial implementation requests.
- while in plan mode, the agent can do non-mutating exploration and clarify requirements via `AskUserQuestion`.
- mutating implementation actions are blocked until plan approval, except writing the plan file.
- `ExitPlanMode` is the only plan-approval handshake (do not ask "should I proceed?" via free text/Q&A).

Plan artifacts (programmatic-only surface):

- maintain a structured plan object in session state (no TUI dependency).
- plan file is mandatory in plan mode.
- if session starts in plan mode and no plan file exists, auto-create an empty plan file immediately.
- if entering plan mode from non-plan mode and no plan file exists, auto-create one before next model step.
- plan file path must be outside the project tree and randomly named, under global state storage (for example: `~/.local/state/loxel/coding-agent/plans/<random>.md`).
- on `ExitPlanMode` approval, inject an execution reminder that references the approved plan artifact/state.

Plan-mode tool constraints:

- read access can target the entire project/workspace.
- `Edit`/`Write`/`MultiEdit` are allowed only when `file_path === planFilePath`.
- all other file mutations are rejected with `TOOL_POLICY_VIOLATION`.
- `Bash` is disabled in plan mode.
- `Task` subagents inherit parent scope and therefore cannot escape plan-mode constraints.

Plan prompt requirements:

- include the absolute plan file path in the plan-mode system overlay every turn.
- explicitly instruct the agent to write/update the plan in that file.
- explicitly instruct that plan approval must use `ExitPlanMode`, not plain text and not `AskUserQuestion`.

Plan-tracking behavior:

- create/update explicit steps
- mark step states (`pending`, `in_progress`, `completed`, `blocked`)
- provide concise rationale for state transitions
- maintain one active `in_progress` step when applicable

Plan events:

- `plan.mode.entered`
- `plan.mode.exited`
- `plan.created`
- `plan.updated`
- `plan.step.changed`
- `plan.completed`

### 6) Ask-User / Approval Flow

All approval and persistence rules in this section are `MUST`.

Policy engine for escalation and consent:

- classify action risk (`safe`, `needs_confirmation`, `blocked`)
- require explicit approval for destructive/system-affecting actions
- support scoped reusable approvals with explicit user intent.

Standardized approval payload:

- action summary
- exact command/tool request
- risk reason
- minimal required scope

Approval decision options (required):

- `allow` (one-time allow, not persisted)
- `allow_this_session` (persist to session permission store)
- `allow_always` (persist to project permission store)
- `deny` (one-time deny, not persisted)

Permission persistence rules:

- `allow` and `deny` affect current request only.
- `allow_this_session` writes a normalized rule to session permissions.
- `allow_always` writes a normalized rule to project permissions.
- permission state is never rewound by conversation rewind.

Permission resolution order:

1. explicit per-call override (host)
2. session permission rules
3. project permission rules
4. default policy profile

### 7) Streaming + Interruptibility

Required control behaviors:

- incremental partial output streaming
- cancellation token propagation to model + tools
- interruption-safe completion events
- idempotent retry semantics for host-driven reruns

### 8) Model Routing Strategy (OpenRouter)

Define model profiles rather than hard-coding:

- `planner`: strongest long-context reasoning (GLM-5 / Kimi K2.5 configurable)
- `executor`: fast tool-calling and deterministic formatting
- `fallback`: automatic failover when provider/model errors occur

Routing concerns:

- per-turn model override
- max tokens / temperature defaults by phase
- tool-call reliability tuning (JSON schema strictness, repair attempts)

## Context Engineering + Prompt Management

Prompt system should be layered and composable:

- `base system` layer: core behavior, safety, and protocol guarantees
- `mode` layer: plan mode, execute mode, review mode, etc.
- `tool` layer: per-tool usage constraints and formatting guidance
- `task` layer: user/developer objectives and acceptance criteria
- `session memory` layer: compact persisted context and recent outcomes

Prompt source strategy:

- keep prompts versioned and testable as files
- define a deterministic merge order for prompt layers
- support profile-based prompt bundles per model family (GLM-5 vs Kimi K2.5)
- use the referenced prompt corpus as input inspiration for mode/tool/system prompt coverage and gaps

Prompt corpus extraction plan (from cloned `claude-code-system-prompts`):

- build a normalized prompt catalog keyed by prompt type (`system`, `reminder`, `tool`, `agent`, `data`, `skill`)
- map each tool prompt to explicit behavioral constraints (e.g., parallelism, read-only plan mode, approval handling)
- distill token-efficient rules into reusable prompt snippets:
  - prefer specialized tools over shell for file/search
  - keep tool descriptions concise and task-specific
  - keep intermediate updates short and progress-oriented
  - require source citation behavior for web search-enabled responses
- version these distilled prompts independently from runtime logic

Prompt governance:

- every prompt bundle has version + changelog metadata
- runtime emits prompt profile/version in telemetry for reproducibility
- keep prompt templates provider-agnostic where possible

### Prompt Taxonomy (What We Need To Author)

Prompt families to maintain (based on Claude prompt corpus patterns and harness research):

- `system-prompt`:
  - durable global behavior and safety policy.
  - examples: execution-care policy, tool-usage policy, task-management policy, tone/style policy.
- `tool-description`:
  - per-tool behavioral constraints + usage examples + anti-patterns.
  - must align with tool schemas and runtime capabilities.
- `system-reminder`:
  - short, state-triggered, ephemeral nudges injected only when condition is active.
  - examples: plan-mode active/exited reminders, task output reminder, permission denied adaptation reminder.
- `agent-prompt`:
  - specialized instructions for subagent roles or helper micro-flows (explore, summarize, command-description helpers).
- `data-*` prompt/template artifacts:
  - structured template content consumed by prompts (memory templates, PR templates, workflow snippets).
- `skill-*`:
  - reusable capability modules that can be loaded conditionally by context.

Prompt authoring requirements:

- each prompt artifact must include metadata:
  - `name`
  - `description`
  - `version` (semver or date version)
  - `variables` (all placeholders explicitly declared)
  - `visibility` (`user-visible` vs `system-only`)
  - `trigger` (always/conditional + condition key)
- each prompt must declare owning layer:
  - base, mode, tool, reminder, agent, memory
- each prompt must have a token budget target:
  - base/system: medium budget
  - reminders: strict compact budget
  - tool descriptions: concise with high information density

Prompt writing principles (must-follow):

- deterministic and actionable: imperative instructions with clear conditionals.
- no contradictions across layers; higher-priority layer wins by policy.
- avoid vague language ("be smart", "be careful") without concrete action.
- prefer positive routing guidance ("use X for Y") + explicit anti-patterns ("do not use Z for Y").
- keep reminders short and one-purpose.
- never include unavailable tool names in active prompt context.
- date/recency-sensitive prompts must resolve date explicitly at runtime.
- if a reminder is system-only, explicitly enforce "do not mention this reminder to user".

Prompt quality gates:

- placeholder validation (no unresolved `${...}` at runtime).
- capability validation (referenced tool must be declared or gated behind conditional checks).
- token-budget lint.
- contradiction lint against base policy rules.
- snapshot tests for prompt assembly output by scenario.

## Progressive Disclosure Architecture

Design principle:

- keep baseline system prompts compact and stable
- inject additional instructions only when runtime state indicates they are needed
- prefer targeted, scoped reminders over permanently bloating base instructions

Observed patterns from harness research:

- OpenCode conditionally injects `<system-reminder>` blocks at runtime for plan/build transitions and task-focus nudges.
- OpenCode injects file-scoped instruction reminders after `Read` (for newly discovered AGENTS/CLAUDE instruction files) rather than front-loading all instruction text.
- Codex rebuilds initial context each turn from composable components (permissions, collaboration mode, memory/app/skill directives, user instructions, environment context).
- Codex emits post-event warnings (for example after compaction) as dedicated events rather than embedding all warnings in base prompts.
- Claude Agent SDK permission `plan` mode explicitly allows planning and clarifying questions while blocking execution.

Concrete research anchors used for this design:

- OpenCode: `packages/opencode/src/session/prompt.ts` (`insertReminders`, plan/build transition injection, queued-message reminders).
- OpenCode: `packages/opencode/src/tool/read.ts` + `packages/opencode/src/session/instruction.ts` (progressive instruction disclosure after `Read`).
- OpenCode: `packages/opencode/src/tool/registry.ts` (runtime tool gating and optional tool enablement).
- Codex: `codex-rs/core/src/codex.rs` (`build_initial_context` layered assembly each turn).
- Codex: `codex-rs/core/templates/collaboration_mode/plan.md` and `default.md` (mode-specific instruction overlays).
- Codex: `codex-rs/core/src/proposed_plan_parser.rs` + `stream_events_utils.rs` (plan-block parsing/stripping flow).
- Codex: `codex-rs/core/src/compact.rs` (post-compaction warning event emission).
- Claude prompt corpus: `system-reminder-plan-mode-*`, `system-reminder-exited-plan-mode.md`, `tool-description-{websearch,toolsearch,askuserquestion,enterplanmode,exitplanmode}.md`.

### Prompt Layers (Disclosure Order)

Use deterministic assembly order:

1. base model/harness instructions
2. permissions + sandbox + approval policy instructions
3. collaboration mode overlay (`default` / `plan` / `execute`)
4. session/project instructions (AGENTS, skills, configured docs)
5. state-triggered reminders (ephemeral, TTL-bound)
6. per-turn user/developer supplements

### Trigger Matrix (State -> Injection)

- `mode_entered:plan`
  - inject strict plan-mode reminder (read-only except plan-file edits) + planning workflow + plan artifact path
  - disallow execution-oriented tool instructions
- `mode_exited:plan` or `ExitPlanMode` approved
  - inject build-transition reminder with approved plan location and implementation guidance
- `tool_called:Task` (background or resumable)
  - inject reminder with `task_id`, how to retrieve output (`TaskOutput`), and how to stop (`TaskStop`)
- `tool_called:Bash` with `run_in_background=true`
  - inject short reminder describing background follow-up controls (`TaskOutput` + `TaskStop`)
- `tool_called:Read` discovering higher-scope instructions
  - inject scoped instruction delta only (newly discovered files)
- `permission_denied` / `approval_rejected`
  - inject adaptation reminder (do not retry identical call, propose alternatives, or ask user)
- `context_compacted`
  - inject accuracy caution and thread/session continuation guidance
- `messages_since_last_reminder >= N` and condition still active
  - reinject concise reminder snippet (cooldown-controlled)

### Reminder Queue + Counters

Maintain internal reminder state:

- `activeConditions`: set of condition keys currently true
- `reminderHistory`: last injected turn index per condition
- `cooldowns`: min turns/messages between repeats per condition
- `maxRepeats`: cap to avoid prompt spam
- `conditionPayload`: per-condition payload state (eg `task_id`, `shell_id`, `planFilePath`)
- snapshot/restore support so rewind can restore reminder counters accurately

Default reminder scheduler values:

- `plan_mode_active`: inject every turn until exit
- `background_task_active`: inject every 3 assistant turns until task completion/stop
- `permission_denied`: inject next 1 turn only
- `context_compacted`: inject on first post-compaction turn, then every 6 turns max

Policy defaults:

- high-severity constraints (plan read-only, denied approval semantics): low cooldown, repeatable
- informational reminders (background output retrieval): medium cooldown
- stylistic reminders: high cooldown or one-shot
- rewind restores this scheduler state to the selected message snapshot; permissions are unchanged.

### Reminder Payload Design

Each reminder should be:

- short (target <= 80-160 tokens)
- action-oriented (what to do now)
- tool-name explicit (`TaskOutput`, `TaskStop`, `ToolSearch`, etc.)
- idempotent and safe to re-inject
- tagged with a stable `reminderKey` for dedupe

### Prompt Assembly Engine (Specification Requirement)

Define a dedicated `PromptAssembler` with:

- input: session state, turn state, tool-call history, mode, permission state, reminders state
- output:
  - `systemSegments[]` (ordered, tagged)
  - `developerSegments[]` (policy/mode overlays)
  - `ephemeralReminderSegments[]`
  - `assemblyMetadata` (segment IDs, token counts, dropped segments)

Assembly behaviors:

- strict ordering + deterministic sorting by segment priority
- token budget partitioning per segment class
- graceful truncation: drop lowest-priority informational reminders first
- hash-based cache keys to maximize prompt caching reuse

### Cross-Surface Capability Model (Claude/Codex/OpenCode)

Because tool surfaces vary by product/surface, maintain three sets:

- `declared`: tools exposed by current runtime (eg. Claude MCP list)
- `documented`: tools referenced by official docs/prompts (eg. `LS`, `MultiEdit`, `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`)
- `latent`: tools inferred from sibling harnesses or runtime variants (`BashOutput`, `KillShell`, `TodoRead`)

Rules:

- only callable tools come from `declared`
- reminder/prompts can reference `documented`/`latent` only when capability checks confirm availability
- fallback instructions must be defined when a documented tool is absent (eg. directory listing via `Glob("*")`)

## Agent Loop (Detailed Runtime Design)

### Runtime State Machine

Primary turn states:

1. `IDLE`
2. `PREPARE_TURN`
3. `ASSEMBLE_PROMPT`
4. `MODEL_STEP`
5. `PROCESS_TOOL_CALLS`
6. `WAIT_HUMAN` (for `AskUserQuestion`/approval)
7. `POST_STEP_EVAL`
8. `COMPLETE` | `FAILED` | `CANCELLED`

Mode-aware invariants:

- `plan` mode: only planning-safe actions and read-only exploration (plus plan-file edits).
- `default/execute` mode: full tool set subject to approval policies.
- mode transitions only via explicit orchestrator/tool events (`EnterPlanMode` / `ExitPlanMode` or host override).

### Turn Loop (Step-by-Step)

1. Ingest:
   - append inbound user/developer/system messages.
   - resolve session mode, capability set, approval policy, and reminder conditions.
   - if run was resumed with `rewind_to_message_id`, set active branch pointer to that message snapshot, restore agent-controlled state snapshot, and emit `session.rewound`.
2. Assemble prompt:
   - run `PromptAssembler` with deterministic layering.
   - attach ephemeral reminders for active conditions.
3. Model step:
   - call `streamText`/`generateText` with tool set + `stopWhen` + step hooks.
   - emit incremental `run.delta`.
4. Tool dispatch:
   - parse tool calls in order; execute safe parallelism where independent.
   - for gated calls, emit `approval.requested` and transition to `WAIT_HUMAN`.
   - for `AskUserQuestion`, emit `human.input.requested` and transition to `WAIT_HUMAN`.
5. Tool result append:
   - validate outputs against output schema.
   - append tool result messages back into conversation.
   - emit `tool.call.result`.
6. Post-step evaluation:
   - evaluate stop conditions (step cap, explicit completion signal, cancellation, unrecoverable error).
   - update reminders/counters.
   - continue loop or finalize run.
7. Finalize:
   - emit `run.completed` or `run.failed`/`run.cancelled`.
   - persist all relevant protocol/session events to `events.jsonl` for replay (`message.appended`, `state.updated`, session lifecycle, tool calls/results, human/approval interactions, reminders updates).

Manual compaction path:

- host can invoke `session.compact` between turns.
- compaction emits `context.compaction.started/completed/failed`.
- compaction performs summarize+replace for active model context while preserving full raw history for future rewind/fork.

### Stop Conditions

Hard stops:

- cancellation requested
- max-step limit reached
- fatal validation/provider/tool error

Soft stops:

- awaiting human response
- explicit plan-handshake boundary (`ExitPlanMode` called and awaiting approval)
- model returned completion without pending tool calls

### Protocol Event Mapping (Loop Observability)

Per step emit:

- `run.step.started`
- `run.step.model.delta`
- `run.step.model.completed`
- `run.step.tool.batch.started`
- `run.step.tool.call.requested`
- `run.step.tool.call.completed`
- `run.step.completed`

Cross-step emit:

- `approval.requested` / `approval.granted` / `approval.denied`
- `human.input.requested` / `human.input.response`
- `plan.mode.entered` / `plan.mode.exited`
- `context.compaction.started` / `context.compaction.completed` / `context.compaction.failed`
- `subagent.session.started` / `subagent.session.updated`

Persistence-specific event rules:

- `events.jsonl` MUST include every event needed to reconstruct conversation and agent-controlled session state.
- protocol events MAY be persisted as normalized `protocol.event` entries carrying `event_type`, `payload`, `runId`, and `requestId`.
- subagent events SHOULD be in the same `events.jsonl` stream with scope metadata (`scope.kind=subagent`, `scope.agentId`, `scope.parentAgentId`).

### Concurrency Model

Allowed parallelism:

- parallel tool calls only when independent and side-effect-safe.
- parallel subagent `Task` launches by design when requested/beneficial.

Disallowed parallelism:

- mutating tools targeting same file/path set in same batch unless atomic coordinator is used (`MultiEdit` path).
- execution in plan mode that violates non-mutating policy.

### Error Model

Error classes:

- `validation_error`
- `approval_denied`
- `human_timeout`
- `provider_error`
- `tool_runtime_error`
- `policy_violation`

Each error must include:

- stable machine code
- user-safe message
- retriable flag
- recommended next action

Runtime diagnostics requirements:

- internal runtime failures that do not immediately abort a run (for example protocol-event append failure) MUST be surfaced as `runtime.warning` or `runtime.error` events.
- programmatic runtime API SHOULD expose an error listener/callback (`.on("error", ...)`-style) carrying the same diagnostic payload for host observability.

## State Layout (Filesystem)

All persistent agent state lives under:

- `~/.local/state/loxel/coding-agent/`

Proposed hierarchy:

- `settings.json`
- `permissions/`
  - `project/<projectHash>.json` (`allow_always` rules)
  - `session/<sessionId>.json` (`allow_this_session` rules)
- `plans/`
  - `<random>.md` (global plan artifacts, reusable across forks/sessions)
- `sessions/<sessionId>/`
  - `events.jsonl` (**strict source of truth**, append-only event log)
  - `branches/` (branch heads and branch metadata)
  - `artifacts/`
    - `compactions/<compactionId>.json` (compaction summaries + metadata)
    - `tool-output/` (large truncated outputs referenced by tools)

Storage rules:

- never store state in project repo directories by default.
- plan files must be random-named files in global state storage and MAY be shared by forked sessions.
- permissions are independent stores and are not affected by rewind/compact.
- replay/rebuild MUST use `events.jsonl` only.

## Session Management (Parity-Oriented)

Persistent session capabilities:

- save sessions to file-backed storage
- resume sessions by `sessionId`
- fork sessions from any checkpoint/message index
- rewind to a specific message boundary with branchable history
- trigger manual compaction on demand

Session storage format:

- append-only `events.jsonl` per session (source of truth for replay)
- `artifacts/` folder for task logs and compaction summaries

Session state model includes:

- immutable message/event history (SDK-native messages + tool events)
- branch graph (not just one linear transcript)
- active branch pointer + active message pointer
- tool call/result history
- plan state timeline
- todo state timeline
- approval decisions
- prompt profile/version used per run
- reminder scheduler state (`activeConditions`, cooldown counters, dedupe keys)

Session operations:

- `session.resume` (supports optional rewind boundary by message ID)
- `session.fork`
- `session.compact`
- `session.list` / `session.get` (host-facing management endpoints/events)

Operational semantics:

- `resume`: replay persisted events, then continue with same context + mode.
- `resume` with rewind boundary:
  - `session.resume({ sessionId, rewind_to_message_id })` sets active pointer to `rewind_to_message_id`.
  - next generated assistant/user/tool messages receive new IDs on a new branch.
  - all prior branches remain addressable; any historical message ID can be resumed later.
  - rewind restores agent-controlled state at that point:
    - conversation context passed to model
    - plan state
    - todo state
    - reminder counters/state
  - rewind does **not** restore:
    - filesystem/process/network side effects from prior tool calls
    - permission stores
  - emit `session.rewound` with lineage metadata (`rewindFrom`, `rewindTo`, `activeBranchId`).
- `fork`: clone the full source event stream into a new `sessionId` and preserve full rewindability of the copied timeline.
- `compact`: manually request context compaction for long threads; emit started/completed/failed events.

Compaction semantics (`summarize + replace`, preserving original history):

- compaction creates a new compacted active context while retaining full pre-compaction history.
- active model context is replaced with:
  - summary block
  - essential system/developer prompt state references
  - latest relevant user intent/constraints
  - plan/todo active snapshot
- compaction artifact includes at minimum:
  - compact summary text
  - key decisions + open issues
  - files touched/read
  - approved/active plan path and summary
  - prompt bundle/version metadata used
  - source range in original history
- pre-compaction messages/events remain in storage and remain valid rewind targets.
- emit `context.compaction.completed` with `compactionId`, `sourceRange`, and `activeReplacementPointer`.

Reproducibility requirements:

- deterministic replay mode from stored events
- clear lineage metadata for forks/branches (`parentSessionId`, `forkPoint`, `branchId`, `parentMessageId`)

### 9) Reliability + Safety

- strict JSON schema validation on all inbound/outbound events
- bounded retries with categorized errors (provider/tool/transport/validation)
- audit log stream for all tool calls and approval decisions
- redaction hooks for secrets in logs/events

### 10) Observability

Expose machine-readable telemetry:

- request/run IDs
- latency breakdown (model/tool/human wait)
- token usage and estimated cost
- failure categories and retry counts

### 11) Implementation Quality Requirements

These requirements are normative and apply to package/module design, not only runtime behavior.

Module structure and exports:

- keep a single intentional SDK/public surface at `src/index.ts`.
- avoid internal barrel files and re-export chains.
- export symbols from the module where they are defined; import directly from that module.
- avoid generic `types.ts` files; use domain-specific names (for example `model.ts`, `schema.ts`, `contracts.ts`) colocated with the owning module.

Type safety:

- no `any` for runtime data paths.
- avoid unsafe assertions for untyped external data (tool input, protocol input, state files, JSONL lines, artifact files).
- parse untrusted data with Zod (or explicit type guards) before use.
- derive tool input/output types from Zod schemas with `z.infer`; do not duplicate manual interfaces when schemas already exist.
- prefer deriving variant types with `pick`/`omit`/`exclude` instead of duplicating near-identical types.

Control flow and readability:

- prefer guard clauses and early return/throw to keep happy-path logic flat.
- keep module responsibilities narrow and predictable.
- avoid cross-module access to internals/private behaviors.

Error handling:

- parse errors and corrupted event/state files MUST fail fast with clear, typed errors.
- event replay MUST be strict: malformed JSONL lines, invalid event envelopes, or invalid known-event payloads are fatal.
- `events.jsonl` reconstruction failures MUST never be silently skipped (including in listing APIs).

## Testing Strategy + Fast Feedback Loop

### Testing Principles (Non-Negotiable)

- deterministic by default:
  - fixed seeds, fixed clocks/timers where possible, deterministic IDs in tests.
- hermetic:
  - no live network in unit/integration tests unless explicitly marked `smoke`.
- fast-first:
  - prioritize pure-function and orchestrator-loop tests that run in milliseconds.
- behavior-focused:
  - verify event sequences, policy outcomes, and state transitions over implementation details.
- minimal snapshots:
  - snapshot only stable contracts (event envelopes, prompt assembly segments), not volatile token text.

### Test Layers

1. Schema/contract tests:
   - validate all tool input/output schemas and session event schemas.
   - ensure Zod <-> JSON Schema parity for transport-facing schemas.
2. Tool unit tests:
   - each tool handler tested with mocked context, permission checks, and typed outputs.
   - include policy edge cases (`approval_denied`, timeout, bad params).
3. Orchestrator loop integration tests:
   - use AI SDK mock models (`MockLanguageModelV3`, stream simulation utilities) for deterministic multi-step tool-calling flows.
   - verify loop transitions: model -> tool -> human wait -> resume -> complete.
4. Protocol contract tests:
   - golden tests for stdio event streams (start/delta/tool/human/plan/complete).
5. Provider smoke tests (opt-in/nightly):
   - OpenRouter + selected models for compatibility drift detection only.

### Fast Local Feedback Loop

Core commands:

- run focused tests by file/pattern first.
- keep a watcher running during design/implementation.
- fail fast by default for local iteration.

Bun capabilities to use:

- `--watch` for continuous feedback.
- `--test-name-pattern` for surgical test runs.
- `--bail` for immediate failure stop.
- `--rerun-each` for flake detection loops.
- `--randomize` + `--seed` for order sensitivity detection.
- `--timeout` for strict upper bounds on slow tests.

### What To Test For This Architecture

- tool contract conformance to `claude-tools.json` required fields.
- capability negotiation behavior when optional tools are absent/present.
- progressive disclosure trigger matrix + cooldown logic.
- plan mode invariants (non-mutating constraints, `ExitPlanMode` approval handshake).
- background-task lifecycle (`Bash` + `TaskOutput` + `TaskStop`).
- session lifecycle correctness (persist/resume/fork/rewind lineage + replay determinism).
- rewind semantics correctness:
  - `session.resume({sessionId, rewind_to_message_id})` restores the correct branch snapshot and creates new IDs for subsequent branch messages.
  - rewind restores agent-controlled state (plan/todo/reminder) at the anchor.
  - rewind does not rollback filesystem/tool side effects.
- manual compaction correctness (`session.compact` event flow + post-compaction replay continuity).
- `WebSearch` normalization and source-citation policy behavior.

### Performance Budgets (Design Targets)

- unit/schema tests: sub-second per package.
- orchestrator integration suite: a few seconds, deterministic.
- full local default test run: short enough for frequent invocation during development.
- smoke/provider tests: excluded from default local loop, run in dedicated CI stage.

### CI Strategy

- split jobs by layer (`schema`, `tools`, `loop`, `protocol`, `smoke`).
- gate merges on deterministic layers; smoke failures can be non-blocking initially with alerting.
- collect flaky-test telemetry and quarantine/repair quickly.

## Feature Matrix (Claude Code / Codex CLI-Inspired, Programmatic Angle)

### Tooling

- Structured tool registry with typed schemas
- Parallel/sequential orchestration policy
- Tool result attachment back into conversation state

### Human-in-the-Loop

- Ask-user primitives
- Approval gates for risky actions
- Timeout/escalation behavior

### Planning

- Explicit plan objects
- Step status transitions + rationale
- Plan-first workflow option before execution

### Execution Governance

- Mode flags (plan-first, direct-execute, approval-strict)
- Command/tool guardrails via policy
- Deterministic error envelopes for host recovery

## Appendix A: Tool Contract Matrix

This appendix is normative for default runtime behavior.

| Tool                             | Required Inputs                                                 | Common Optional Inputs                                                                 | Default Limits                                                              | Primary Error Codes                                                                      |
| -------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Read`                           | `file_path`                                                     | `offset`, `limit`                                                                      | 2000 lines, 50 KiB, 2000 char/line                                          | `TOOL_VALIDATION_FAILED`, `TOOL_POLICY_VIOLATION`, `TOOL_RUNTIME_ERROR`                  |
| `Edit`                           | `file_path`, `old_string`, `new_string`                         | `replace_all`                                                                          | find/replace only, read-before-edit policy                                  | `TOOL_VALIDATION_FAILED`, `TOOL_POLICY_VIOLATION`, `TOOL_RUNTIME_ERROR`                  |
| `Write`                          | `file_path`, `content`                                          | none                                                                                   | truncation metadata on large diffs                                          | `TOOL_VALIDATION_FAILED`, `TOOL_POLICY_VIOLATION`, `TOOL_RUNTIME_ERROR`                  |
| `Glob`                           | `pattern`                                                       | `path`                                                                                 | 100 results                                                                 | `TOOL_VALIDATION_FAILED`, `TOOL_POLICY_VIOLATION`, `TOOL_RUNTIME_ERROR`                  |
| `Grep`                           | `pattern`                                                       | `path`, `glob`, `type`, `output_mode`, `head_limit`, `offset`, multiline/context flags | head limit 100, hard max 2000 entries                                       | `TOOL_VALIDATION_FAILED`, `TOOL_POLICY_VIOLATION`, `TOOL_RUNTIME_ERROR`, `TOOL_TIMEOUT`  |
| `Bash`                           | `command`                                                       | `timeout`, `description`, `run_in_background`, `dangerouslyDisableSandbox`             | timeout 120000ms default, 600000ms max; output truncated with artifact path | `TOOL_VALIDATION_FAILED`, `TOOL_PERMISSION_DENIED`, `TOOL_TIMEOUT`, `TOOL_RUNTIME_ERROR` |
| `Task`                           | `description`, `prompt`, `subagent_type`                        | `resume`, `run_in_background`, `max_turns`, `mode`, `model`, `team_name`, `name`       | inherits parent scope; parent/child scope intersection is mandatory         | `TOOL_VALIDATION_FAILED`, `TOOL_POLICY_VIOLATION`, `TOOL_RUNTIME_ERROR`                  |
| `TaskOutput`                     | `task_id`, `block`, `timeout`                                   | none                                                                                   | default `block=true`, timeout 30000ms, max 600000ms                         | `TOOL_VALIDATION_FAILED`, `TOOL_RUNTIME_ERROR`, `TOOL_TIMEOUT`                           |
| `TaskStop`                       | none (at least one of `task_id` or `shell_id` MUST be provided) | `task_id`, `shell_id`                                                                  | generic stop for shell/subagent/remote tasks                                | `TOOL_VALIDATION_FAILED`, `TOOL_RUNTIME_ERROR`                                           |
| `WebFetch`                       | `url`, `prompt`                                                 | none                                                                                   | 30000ms network timeout, tool truncation policy applies                     | `TOOL_VALIDATION_FAILED`, `TOOL_RUNTIME_ERROR`, `TOOL_TIMEOUT`                           |
| `WebSearch`                      | `query`                                                         | `allowed_domains`, `blocked_domains`                                                   | default top 8, hard max 20 results                                          | `TOOL_VALIDATION_FAILED`, `WEBSEARCH_UNAVAILABLE`, `TOOL_RUNTIME_ERROR`                  |
| `AskUserQuestion`                | `questions`                                                     | metadata/options per schema                                                            | host timeout policy                                                         | `TOOL_VALIDATION_FAILED`, `human_timeout`, `approval_denied`                             |
| `EnterPlanMode` / `ExitPlanMode` | none                                                            | provider-specific optional fields for parity                                           | plan file precondition enforced for exit                                    | `TOOL_POLICY_VIOLATION`, `TOOL_RUNTIME_ERROR`                                            |
| `TodoWrite` / `TodoRead`         | `todos` (`TodoWrite`)                                           | none                                                                                   | single `in_progress` invariant                                              | `TOOL_VALIDATION_FAILED`, `TOOL_POLICY_VIOLATION`                                        |
| `ToolSearch`                     | `query`, `max_results`                                          | none                                                                                   | provider/runtime constrained                                                | `TOOL_VALIDATION_FAILED`, `TOOL_RUNTIME_ERROR`                                           |
| `Skill`                          | `skill`                                                         | `args`                                                                                 | runtime constrained                                                         | `TOOL_VALIDATION_FAILED`, `TOOL_NOT_AVAILABLE`, `TOOL_RUNTIME_ERROR`                     |

## Acceptance Criteria

- The specification clearly separates **protocol**, **orchestration**, **human interaction**, and **model routing** concerns.
- Every critical interaction is representable as a typed JSON event.
- Plan mode and ask-user flows are first-class and not bolted on.
- OpenRouter with GLM-5/Kimi K2.5 is captured as a configurable provider strategy, not a hard dependency on single model behavior.
- Scope remains strictly programmatic (no TUI requirements).
- Protocol reuses Vercel AI SDK message/tool type semantics with minimal custom wrappers.
- Tool definitions are DRY: schemas are the single source of truth for runtime validation and static typing.
- The initial tool list and required schema fields are explicitly aligned to `claude-tools.json` (Claude MCP tool inventory).
- Final tool surface is curated and minimal, includes the required tool catalog (`Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash`, `WebFetch`, `WebSearch`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `Task`, `TaskOutput`, `TaskStop`, plus `TodoRead`/`TodoWrite`, `MultiEdit`).
- Tool profiles explicitly define omissions/restrictions by mode (especially plan mode).
- Notebook and slash-command tools are explicitly excluded from this package scope.
- Progressive disclosure includes a concrete trigger matrix, counters/cooldowns, and dedupe rules.
- `WebSearch` implementation path is explicitly defined (OpenRouter web plugin + fallback behavior + source-citation policy).
- Prompt taxonomy and prompt-writing standards are explicitly documented with enforceable quality gates.
- The agent loop/state machine is specified with stop conditions, event mapping, and concurrency/error model.
- Testing strategy defines fast local iteration and deterministic CI layers with clear scope boundaries.
- Session lifecycle includes resume/fork/rewind/compact with lineage metadata and no projection-only protocol mutations.
- `events.jsonl` is the strict source of truth for session reconstruction.
- Replay behavior is strict and fails fast on malformed events.
- Relevant protocol/session events (including tool calls/results, human/approval flow, and subagent lifecycle) are persisted for reconstruction.
- Rewind semantics are explicitly branch-aware and restore agent-controlled state (conversation context, plan, todo, reminders) without rolling back environmental side effects.
- Manual compaction is first-class (`session.compact`) with explicit protocol events.
- Compaction is explicitly summarize+replace for active context while preserving full raw history for future rewind/fork.
- Plan mode requires a mandatory global plan file outside the project tree, with path-guarded edit/write permissions only for that file.
- Permission decisions support `allow`, `allow_this_session`, `allow_always`, `deny` with explicit persistence hierarchy under `~/.local/state/loxel/coding-agent/`.
- CLI integration plan explicitly uses monorepo `cli-common`.
- Implementation quality constraints cover module structure, type safety, runtime parsing of untrusted data, and error-handling behavior.
