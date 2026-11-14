/**
 * Drives the user's installed Claude Code through the Claude Agent SDK: one long-lived streaming
 * `query()` per session. The SDK speaks the same stream-json protocol underneath, so its messages
 * go through the shared {@link ClaudeStreamNormalizer}; what differs is that the SDK owns the
 * process, the control requests and the `can_use_tool` round trip. See docs/AGENT_PANEL.md.
 */
import {
  query as sdkQuery,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  type AgentPermissionMode,
  type AgentRequest,
  type AgentResponse,
  isAgentPermissionMode,
} from "@/api/agent-session-model";
import { withoutAgentEnv } from "@/coding-agent-env";
import { isRecord } from "@/lib/is-record";

import { logger } from "../logger";
import type { AgentLaunch, AgentTransport, AgentTransportHandlers } from "./agent-transport";
import {
  ClaudeStreamNormalizer,
  initialStatus,
  parseCommands,
  parseModels,
  parsePermissionRequest,
} from "./claude-stream-normalizer";

const log = logger.child("agent");

/** How long `stop()` waits for the interrupt it sends first. */
const STOP_INTERRUPT_MS = 2000;

/** The SDK's `query`, replaced by a scripted one in tests. */
export type QueryFunction = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Query;

/** How the transport runs the user's `claude`. */
export interface ClaudeSdkTarget {
  /** The user's own `claude`; the SDK's bundled binary is never used. */
  binary: string;
  env: Record<string, string | undefined>;
  /** `LOXEL_*` variables for the agent's commands, as terminals have them. */
  loxelEnv: Record<string, string>;
}

/** User messages waiting for the SDK to read them: the streaming-input prompt. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly pending: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting) waiting({ value: message, done: false });
    else this.pending.push(message);
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const next = this.pending.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

/** The permission result for the user's response to a pending request. */
export function permissionResult(request: AgentRequest, response: AgentResponse): PermissionResult {
  if (response.kind === "question" && request.kind === "question") {
    return { behavior: "allow", updatedInput: { ...request.input, answers: response.answers } };
  }
  if (response.kind === "plan" && request.kind === "plan") {
    if (!response.approve) {
      return {
        behavior: "deny",
        message: response.feedback?.trim() || "The user wants to keep planning.",
      };
    }
    return {
      behavior: "allow",
      updatedInput: request.input,
      ...(response.mode
        ? { updatedPermissions: [{ type: "setMode", mode: response.mode, destination: "session" }] }
        : {}),
    };
  }
  if (response.kind === "permission" && response.allow && request.kind === "permission") {
    // Only the agent's own suggestions, rebuilt from the request this side holds. They are the
    // agent's own update objects, which the CLI validates; only `destination` is the user's.
    const updates = request.suppressAlwaysAllow
      ? []
      : (response.alwaysAllow ?? []).flatMap(({ index, destination }) => {
          const suggestion = request.suggestions[index];
          return suggestion ? [{ ...suggestion.update, destination } as PermissionUpdate] : [];
        });
    return {
      behavior: "allow",
      updatedInput: request.input,
      ...(updates.length > 0 ? { updatedPermissions: updates } : {}),
    };
  }
  return {
    behavior: "deny",
    message: (response.kind === "permission" && response.message?.trim()) || "The user declined.",
  };
}

/** The SDK's `canUseTool` arguments as the `can_use_tool` control request the normalizer parses. */
function canUseToolRequest(
  toolName: string,
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2],
): Record<string, unknown> {
  return {
    subtype: "can_use_tool",
    tool_name: toolName,
    input,
    tool_use_id: options.toolUseID,
    permission_suggestions: options.suggestions ?? [],
    decision_reason: options.decisionReason,
    display_name: options.displayName,
    description: options.description,
    title: options.title,
    blocked_path: options.blockedPath,
    suppress_always_allow_rule: options.suppressAlwaysAllowRule,
    default_to_no: options.defaultToNo,
  };
}

interface PendingTool {
  request: AgentRequest;
  resolve(result: PermissionResult): void;
}

export class ClaudeSdkTransport implements AgentTransport {
  private q: Query | null = null;
  private readonly input = new MessageQueue();
  private readonly normalizer = new ClaudeStreamNormalizer();
  private readonly pendingTools = new Map<string, PendingTool>();
  private stopping = false;
  /** Settles when the SDK's message stream ends, which it does once the CLI has exited. */
  private finished: Promise<void> = Promise.resolve();

  constructor(
    private readonly launch: AgentLaunch,
    /** Where and how to run `claude`; throws, with a reason for the user, if it may not run. */
    private readonly target: (launch: AgentLaunch) => ClaudeSdkTarget,
    private readonly handlers: AgentTransportHandlers,
    private readonly query: QueryFunction = sdkQuery,
  ) {}

  async start(): Promise<void> {
    const { binary, env, loxelEnv } = this.target(this.launch);
    const spawnEnv: Record<string, string> = {};
    const merged = {
      ...withoutAgentEnv(env),
      ...loxelEnv,
      LOXEL_WORKTREE: this.launch.worktreePath,
    };
    for (const [name, value] of Object.entries(merged)) {
      if (value !== undefined) spawnEnv[name] = value;
    }

    const q = this.query({
      prompt: this.input,
      options: {
        cwd: this.launch.worktreePath,
        pathToClaudeCodeExecutable: binary,
        env: spawnEnv,
        // Without the preset the SDK sends an empty system prompt, unlike `claude` itself.
        systemPrompt: { type: "preset", preset: "claude_code" },
        // Without a handler AskUserQuestion and the plan mode tools are left out of the toolset.
        canUseTool: (toolName, toolInput, options) => this.canUseTool(toolName, toolInput, options),
        includePartialMessages: true,
        // Echo each user message once the CLI takes it, which is when a queued one is delivered.
        extraArgs: { "replay-user-messages": null },
        ...(this.launch.resume
          ? { resume: this.launch.sessionId }
          : { sessionId: this.launch.sessionId }),
        stderr: (data) => log.debug("claude stderr", { data: data.slice(0, 2000) }),
      },
    });
    this.q = q;
    this.finished = this.readLoop(q);

    const init: Record<string, unknown> = { ...(await q.initializationResult()) };
    // The model and effort the session starts with, after the user's and the project's settings
    // and env overrides; the init message only comes with the first turn. `getSettings` is in the
    // SDK at runtime but not in its types, so it is looked up, and its absence tolerated.
    const getSettings: unknown = Reflect.get(q, "getSettings");
    const settings: unknown =
      typeof getSettings === "function"
        ? await Promise.resolve(getSettings.call(q)).catch(() => null)
        : null;
    const applied = isRecord(settings) && isRecord(settings.applied) ? settings.applied : {};
    this.handlers.onEvents([
      { type: "catalog", commands: parseCommands(init.commands), models: parseModels(init.models) },
      ...(typeof applied.model === "string"
        ? [{ type: "model" as const, model: applied.model }]
        : []),
      ...(typeof applied.effort === "string"
        ? [{ type: "effort" as const, effort: applied.effort }]
        : []),
      ...(isAgentPermissionMode(init.current_permission_mode)
        ? [{ type: "permission_mode" as const, mode: init.current_permission_mode }]
        : []),
      { type: "status", status: initialStatus(init) },
    ]);
  }

  send({ id, text, images, delivery }: Parameters<AgentTransport["send"]>[0]): void {
    this.normalizer.noteSent(id);
    const content = [
      ...images.map((image) => ({
        type: "image" as const,
        source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
      })),
      ...(text ? [{ type: "text" as const, text }] : []),
    ];
    this.input.push({
      type: "user",
      // A UUID the panel minted (the socket schema checks it), echoed back once the CLI takes it.
      uuid: id as SDKUserMessage["uuid"],
      message: { role: "user", content },
      parent_tool_use_id: null,
      // `now` folds the message into the running turn; `next` waits for it to finish.
      priority: delivery === "steer" ? "now" : "next",
      origin: { kind: "human" },
    });
  }

  async interrupt(): Promise<void> {
    await this.requireQuery().interrupt();
  }

  respond(request: AgentRequest, response: AgentResponse): void {
    const pending = this.pendingTools.get(request.requestId);
    if (!pending) return;
    this.pendingTools.delete(request.requestId);
    this.handlers.onEvents([{ type: "request_resolved", requestId: request.requestId }]);
    pending.resolve(permissionResult(pending.request, response));
  }

  async setPermissionMode(mode: AgentPermissionMode): Promise<void> {
    await this.requireQuery().setPermissionMode(mode);
    this.handlers.onEvents([{ type: "permission_mode", mode }]);
  }

  async setModel(model: string): Promise<void> {
    await this.requireQuery().setModel(model);
    this.handlers.onEvents([{ type: "model", model }]);
  }

  async setEffort(effort: string): Promise<void> {
    // The panel only offers the levels the model lists; the CLI rejects anything else.
    const effortLevel = effort as Parameters<Query["applyFlagSettings"]>[0]["effortLevel"];
    await this.requireQuery().applyFlagSettings({ effortLevel });
    this.handlers.onEvents([{ type: "effort", effort }]);
  }

  async refreshContextUsage(): Promise<void> {
    const usage: unknown = await this.requireQuery().getContextUsage({ detail: "summary" });
    if (!isRecord(usage)) return;
    // The SDK passes the CLI's answer through; accept both of the names it has used.
    const percentage = usage.percentage;
    const totalTokens = usage.totalTokens ?? usage.total_tokens;
    const maxTokens = usage.maxTokens ?? usage.raw_max_tokens;
    if (
      typeof percentage !== "number" ||
      typeof totalTokens !== "number" ||
      typeof maxTokens !== "number"
    ) {
      return;
    }
    this.handlers.onEvents([
      { type: "context_usage", usage: { percentage, totalTokens, maxTokens } },
    ]);
  }

  async stop(): Promise<void> {
    const q = this.q;
    if (!q) return;
    this.stopping = true;
    this.denyPending("The session stopped.");
    // A running turn would hold the process up, so interrupt it first; closing the query then
    // ends the CLI. The message stream ends once the process has exited.
    await Promise.race([q.interrupt().catch(() => {}), Bun.sleep(STOP_INTERRUPT_MS)]);
    this.input.close();
    q.close();
    await this.finished;
  }

  private requireQuery(): Query {
    if (!this.q || this.stopping) throw new Error("The agent process is not running");
    return this.q;
  }

  private canUseTool(
    toolName: string,
    toolInput: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const request = parsePermissionRequest(
      options.requestId,
      canUseToolRequest(toolName, toolInput, options),
    );
    if (!request) {
      return Promise.resolve({ behavior: "deny", message: "Loxel could not read this request." });
    }
    return new Promise((resolve) => {
      if (options.signal.aborted) {
        resolve({ behavior: "deny", message: "Interrupted." });
        return;
      }
      // An interrupt aborts the request, and its card is withdrawn.
      options.signal.addEventListener(
        "abort",
        () => {
          if (!this.pendingTools.delete(request.requestId)) return;
          this.handlers.onEvents([{ type: "request_resolved", requestId: request.requestId }]);
          resolve({ behavior: "deny", message: "Interrupted." });
        },
        { once: true },
      );
      this.pendingTools.set(request.requestId, { request, resolve });
      this.handlers.onEvents([{ type: "request", request }]);
    });
  }

  private denyPending(message: string): void {
    for (const [requestId, pending] of this.pendingTools) {
      this.handlers.onEvents([{ type: "request_resolved", requestId }]);
      pending.resolve({ behavior: "deny", message });
    }
    this.pendingTools.clear();
  }

  private async readLoop(q: Query): Promise<void> {
    let error: string | null = null;
    try {
      for await (const message of q) {
        const events = this.normalizer.normalize(message);
        if (events.length > 0) this.handlers.onEvents(events);
      }
      if (!this.stopping) error = "Claude Code exited.";
    } catch (err) {
      if (!this.stopping) {
        log.warn("The agent process failed", { error: err });
        error = err instanceof Error ? err.message : String(err);
      }
    }
    this.q = null;
    this.denyPending("The agent stopped.");
    this.handlers.onExit(error);
  }
}
