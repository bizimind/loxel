/**
 * Turns Claude Code's stream-json output (and the records of its session transcript, which share
 * the message shapes) into transport-independent {@link AgentEvent}s. Everything it reads is
 * untyped JSON from another program, so every field is checked before use and anything it does not
 * recognize is skipped: a newer CLI adding frames degrades to not showing them.
 */
import {
  type AgentCommand,
  type AgentEvent,
  type AgentModel,
  type AgentQuestion,
  type AgentRequest,
  type AgentStatus,
  isAgentPermissionMode,
  type PermissionSuggestion,
} from "@/api/agent-session-model";
import { isRecord } from "@/lib/is-record";

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Text of a tool_result's `content`: a string, or text blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  return records(content)
    .map((block) => (block.type === "text" ? (str(block.text) ?? "") : `[${str(block.type)}]`))
    .join("\n");
}

/** Strips terminal escapes from text the CLI says may carry them (decision reasons). */
function plainText(text: string): string {
  // oxlint-disable-next-line no-control-regex -- removing control sequences is the point
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function parseCommands(value: unknown): AgentCommand[] {
  return records(value).flatMap((command) => {
    const name = str(command.name);
    // `__`-prefixed commands are the CLI's internal ones (server-launched workflows).
    if (!name || name.startsWith("__")) return [];
    return [
      {
        name,
        description: str(command.description) ?? "",
        argumentHint: str(command.argumentHint) ?? "",
      },
    ];
  });
}

export function parseModels(value: unknown): AgentModel[] {
  return records(value).flatMap((model) => {
    const value = str(model.value);
    if (!value) return [];
    return [
      {
        value,
        resolvedModel: str(model.resolvedModel) ?? null,
        displayName: str(model.displayName) ?? value,
        description: str(model.description) ?? "",
        effortLevels: strings(model.supportedEffortLevels),
      },
    ];
  });
}

function suggestionLabel(update: Record<string, unknown>): string {
  if (update.type === "setMode") return `Switch to ${str(update.mode) ?? "another mode"}`;
  if (update.type === "addDirectories") return `Allow ${strings(update.directories).join(", ")}`;
  const rules = records(update.rules).map((rule) => {
    const tool = str(rule.toolName) ?? "tool";
    const content = str(rule.ruleContent);
    return content ? `${tool}(${content})` : tool;
  });
  return rules.length > 0 ? rules.join(", ") : (str(update.type) ?? "rule");
}

function parseSuggestions(value: unknown): PermissionSuggestion[] {
  return records(value).map((update) => ({
    update,
    label: suggestionLabel(update),
    destination: str(update.destination) ?? "session",
  }));
}

function parseQuestions(input: Record<string, unknown>): AgentQuestion[] {
  return records(input.questions).map((q) => ({
    question: str(q.question) ?? "",
    header: str(q.header) ?? "",
    multiSelect: q.multiSelect === true,
    options: records(q.options).map((o) => ({
      label: str(o.label) ?? "",
      description: str(o.description) ?? "",
    })),
  }));
}

/** The {@link AgentRequest} for a `can_use_tool` control request, or null if it is malformed. */
export function parsePermissionRequest(
  requestId: string,
  request: Record<string, unknown>,
): AgentRequest | null {
  const toolName = str(request.tool_name);
  const toolUseId = str(request.tool_use_id);
  const input = isRecord(request.input) ? request.input : null;
  if (!toolName || !toolUseId || !input) return null;
  if (toolName === "AskUserQuestion") {
    return { kind: "question", requestId, toolUseId, input, questions: parseQuestions(input) };
  }
  if (toolName === "ExitPlanMode") {
    return {
      kind: "plan",
      requestId,
      toolUseId,
      input,
      plan: str(input.plan) ?? "",
      planFilePath: str(input.planFilePath),
    };
  }
  const reason = str(request.decision_reason);
  return {
    kind: "permission",
    requestId,
    toolName,
    displayName: str(request.display_name) ?? toolName,
    toolUseId,
    input,
    description: str(request.description) ?? str(request.title),
    reason: reason ? plainText(reason) : undefined,
    suggestions: parseSuggestions(request.permission_suggestions),
    suppressAlwaysAllow: request.suppress_always_allow_rule === true,
    defaultToNo: request.default_to_no === true,
  };
}

/** What `system/session_state_changed` and the initialize response call the session's state. */
function statusFromSessionState(state: unknown): AgentStatus | null {
  if (state === "idle") return "idle";
  if (state === "running") return "working";
  if (state === "requires_action") return "needs_input";
  return null;
}

export class ClaudeStreamNormalizer {
  /** Assistant frames seen per API message, which numbers its content blocks. */
  private readonly blocksSeen = new Map<string, number>();
  /** User messages this side sent, whose echo marks them delivered instead of adding them. */
  private readonly sentIds = new Set<string>();

  noteSent(id: string): void {
    this.sentIds.add(id);
  }

  /** Events for one frame of stream-json output, or one record of the session transcript. */
  normalize(frame: unknown): AgentEvent[] {
    if (!isRecord(frame)) return [];
    switch (frame.type) {
      case "system":
        return this.system(frame);
      case "stream_event":
        return this.streamEvent(frame);
      case "assistant":
        return this.assistant(frame);
      case "user":
        return this.user(frame);
      case "result":
        return this.result(frame);
      default:
        return [];
    }
  }

  private system(frame: Record<string, unknown>): AgentEvent[] {
    switch (frame.subtype) {
      case "init": {
        const sessionId = str(frame.session_id);
        if (!sessionId) return [];
        return [
          {
            type: "session",
            sessionId,
            agentVersion: str(frame.claude_code_version) ?? "",
            model: str(frame.model) ?? "",
            permissionMode: isAgentPermissionMode(frame.permissionMode)
              ? frame.permissionMode
              : null,
            capabilities: strings(frame.capabilities),
          },
        ];
      }
      case "status": {
        const events: AgentEvent[] = [];
        if (isAgentPermissionMode(frame.permissionMode)) {
          events.push({ type: "permission_mode", mode: frame.permissionMode });
        }
        if (frame.status === "requesting" || frame.status === "compacting") {
          events.push({ type: "status", status: "working" });
        }
        return events;
      }
      case "session_state_changed": {
        const status = statusFromSessionState(frame.state);
        // needs_input comes from the requests themselves, which also say what is asked.
        return status && status !== "needs_input" ? [{ type: "status", status }] : [];
      }
      case "commands_changed":
        return [{ type: "catalog", commands: parseCommands(frame.commands) }];
      case "local_command_output": {
        const text = str(frame.content);
        return text ? [this.notice(frame, "info", text)] : [];
      }
      case "compact_boundary":
        return [this.notice(frame, "info", "Conversation compacted")];
      case "task_started": {
        const description = str(frame.description);
        return description ? [this.notice(frame, "info", `Task started: ${description}`)] : [];
      }
      case "task_notification": {
        const summary = str(frame.summary) ?? str(frame.status);
        return summary ? [this.notice(frame, "info", `Task: ${summary}`)] : [];
      }
      default:
        return [];
    }
  }

  private notice(
    frame: Record<string, unknown>,
    level: "info" | "error",
    text: string,
  ): AgentEvent {
    const id = str(frame.uuid) ?? `notice-${crypto.randomUUID()}`;
    return { type: "item", item: { kind: "notice", id, level, text } };
  }

  private streamEvent(frame: Record<string, unknown>): AgentEvent[] {
    const event = isRecord(frame.event) ? frame.event : null;
    const messageId = str(frame.api_message_id);
    if (!event || !messageId || typeof event.index !== "number") return [];
    if (event.type !== "content_block_delta" || !isRecord(event.delta)) return [];
    const delta = event.delta;
    const parentToolUseId = str(frame.parent_tool_use_id) ?? null;
    const id = `${messageId}:${event.index}`;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      return [{ type: "delta", id, kind: "text", text: delta.text, parentToolUseId }];
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      return [{ type: "delta", id, kind: "thinking", text: delta.thinking, parentToolUseId }];
    }
    return [];
  }

  private assistant(frame: Record<string, unknown>): AgentEvent[] {
    const message = isRecord(frame.message) ? frame.message : null;
    if (!message) return [];
    const messageId = str(message.id) ?? str(frame.uuid) ?? crypto.randomUUID();
    const parentToolUseId = str(frame.parent_tool_use_id) ?? null;
    const events: AgentEvent[] = [];
    // The CLI writes one assistant frame per content block, in block order; a transcript record
    // may hold several. Either way the n-th block of a message is the stream's block index n.
    for (const block of records(message.content)) {
      const index = this.blocksSeen.get(messageId) ?? 0;
      this.blocksSeen.set(messageId, index + 1);
      const id = `${messageId}:${index}`;
      if (block.type === "text") {
        const text = str(block.text) ?? "";
        events.push({
          type: "item",
          item: { kind: "text", id, text, streaming: false, parentToolUseId },
        });
      } else if (block.type === "thinking") {
        const text = str(block.thinking) ?? "";
        events.push({
          type: "item",
          item: { kind: "thinking", id, text, streaming: false, parentToolUseId },
        });
      } else if (block.type === "tool_use") {
        const toolUseId = str(block.id);
        if (!toolUseId) continue;
        events.push({
          type: "item",
          item: {
            kind: "tool",
            id: toolUseId,
            name: str(block.name) ?? "tool",
            input: block.input,
            result: null,
            parentToolUseId,
          },
        });
      }
    }
    return events;
  }

  private user(frame: Record<string, unknown>): AgentEvent[] {
    const message = isRecord(frame.message) ? frame.message : null;
    if (!message || frame.isSynthetic === true || frame.isMeta === true) return [];
    const content = message.content;
    if (typeof content === "string") return this.userText(frame, content, 0);
    const blocks = records(content);
    const results = blocks.filter((block) => block.type === "tool_result");
    if (results.length > 0) {
      return results.flatMap((block) => {
        const toolUseId = str(block.tool_use_id);
        if (!toolUseId) return [];
        return [
          {
            type: "tool_result" as const,
            toolUseId,
            text: toolResultText(block.content),
            isError: block.is_error === true,
          },
        ];
      });
    }
    const text = blocks
      .filter((block) => block.type === "text")
      .map((block) => str(block.text) ?? "")
      .join("\n");
    const imageCount = blocks.filter((block) => block.type === "image").length;
    return this.userText(frame, text, imageCount);
  }

  private userText(frame: Record<string, unknown>, text: string, imageCount: number): AgentEvent[] {
    const id = str(frame.uuid);
    if (!id || (!text && imageCount === 0)) return [];
    // Slash command bookkeeping the CLI writes as user messages (`<command-name>`,
    // `<local-command-stdout>`) is not something the user typed.
    if (/^<(command-|local-command-)/.test(text)) return [];
    // The CLI's own marker for an interrupted turn, written as a user message.
    if (text.startsWith("[Request interrupted by user")) {
      return [{ type: "item", item: { kind: "notice", id, level: "info", text: "Interrupted" } }];
    }
    if (this.sentIds.has(id)) return [{ type: "user_message_delivered", id }];
    return [{ type: "user_message", id, text, imageCount, queued: false }];
  }

  private result(frame: Record<string, unknown>): AgentEvent[] {
    const isError = frame.is_error === true || frame.subtype !== "success";
    // An interrupted turn ends as error_during_execution with only diagnostics; the interrupt
    // notice already says what happened.
    const errorText =
      isError && frame.subtype !== "error_during_execution"
        ? str(frame.result) || strings(frame.errors).join("\n") || str(frame.subtype) || null
        : null;
    return [
      {
        type: "turn_result",
        isError,
        costUsd: typeof frame.total_cost_usd === "number" ? frame.total_cost_usd : 0,
        errorText: errorText || null,
      },
      { type: "status", status: "idle" },
    ];
  }
}

/** The status the initialize response reports, for a session joined mid-turn. */
export function initialStatus(response: Record<string, unknown>): AgentStatus {
  return statusFromSessionState(response.session_state) ?? "idle";
}
