/**
 * Turns Claude Code's stream-json messages (what the Agent SDK yields from `query()`, and what
 * `claude -p --output-format stream-json` prints) into agent session updates. Messages are
 * external data, so everything is read as `unknown` and narrowed here; unknown message types are
 * ignored, so a newer CLI degrades instead of breaking.
 */
import {
  isPermissionMode,
  type AgentCommand,
  type AgentSessionInfo,
  type ToolResult,
  type TranscriptItem,
} from "@/api/agent-session-model";

/** One change to an agent session, produced from one or more agent messages. */
export type AgentUpdate =
  | { type: "item"; item: TranscriptItem }
  | { type: "append"; id: string; text: string }
  | { type: "tool_result"; toolUseId: string; result: ToolResult }
  /** A user message the agent took in (`--replay-user-messages`), by the uuid it was sent with. */
  | { type: "user_delivered"; uuid: string }
  | { type: "info"; patch: Partial<AgentSessionInfo> }
  | { type: "activity"; state: "working" | "idle" | "needs_input" }
  | { type: "turn_end"; error: string | null; costUsd: number | null };

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** The text of a tool result's `content`: a string or an array of content blocks. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  return records(content)
    .map((block) => {
      if (block.type === "text") return str(block.text) ?? "";
      if (block.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Text the CLI inserts as user messages around slash commands and skills, not typed by the user. */
const CLI_GENERATED_USER_TEXT =
  /^\s*(<(command-|local-command-|system-reminder|bash-)|\[Request interrupted by user)/;

function userText(content: unknown): { text: string; imageCount: number } {
  if (typeof content === "string") return { text: content, imageCount: 0 };
  let imageCount = 0;
  const parts: string[] = [];
  for (const block of records(content)) {
    if (block.type === "text") parts.push(str(block.text) ?? "");
    if (block.type === "image") imageCount += 1;
  }
  return { text: parts.join("\n"), imageCount };
}

export function parseCommands(value: unknown): AgentCommand[] {
  return records(value).flatMap((command) => {
    const name = str(command.name);
    if (!name) return [];
    return [
      {
        name,
        description: str(command.description) ?? "",
        argumentHint: str(command.argumentHint) ?? "",
      },
    ];
  });
}

interface StreamBlock {
  id: string;
  kind: "assistant" | "thinking";
  finalized: boolean;
}

export class ClaudeMessageTranslator {
  /** The message each conversation (main, or a subagent by parent tool use id) is streaming. */
  private readonly streamingMessage = new Map<string, string>();
  /** Streamed text blocks per message id, in stream order. */
  private readonly streamBlocks = new Map<string, Map<number, StreamBlock>>();
  /** Finalized blocks per message id, to give non-streamed blocks stable ids. */
  private readonly finalizedCount = new Map<string, number>();

  /**
   * Translate one message. `fromHistory` marks messages read back from a saved session, whose user
   * messages are shown as typed (live ones were already shown when they were sent).
   */
  translate(raw: unknown, { fromHistory = false }: { fromHistory?: boolean } = {}): AgentUpdate[] {
    if (!isRecord(raw)) return [];
    const parent = str(raw.parent_tool_use_id) ?? null;
    switch (raw.type) {
      case "system":
        return this.system(raw);
      case "stream_event":
        return this.stream(raw.event, parent);
      case "assistant":
        return this.assistant(raw, parent);
      case "user":
        return this.user(raw, parent, fromHistory);
      case "result":
        return this.result(raw);
      default:
        return [];
    }
  }

  private system(raw: Json): AgentUpdate[] {
    switch (raw.subtype) {
      case "init": {
        const patch: Partial<AgentSessionInfo> = {};
        const sessionId = str(raw.session_id);
        if (sessionId) patch.sessionId = sessionId;
        const model = str(raw.model);
        if (model) patch.model = model;
        if (isPermissionMode(raw.permissionMode)) patch.permissionMode = raw.permissionMode;
        const version = str(raw.claude_code_version);
        if (version) patch.agentVersion = version;
        return [{ type: "info", patch }];
      }
      case "status": {
        const updates: AgentUpdate[] = [];
        if (isPermissionMode(raw.permissionMode)) {
          updates.push({ type: "info", patch: { permissionMode: raw.permissionMode } });
        }
        if (raw.compact_result === "failed") {
          updates.push(
            notice(raw, `Compaction failed: ${str(raw.compact_error) ?? "unknown error"}`, "error"),
          );
        }
        return updates;
      }
      case "session_state_changed": {
        if (raw.state === "running") return [{ type: "activity", state: "working" }];
        if (raw.state === "idle") return [{ type: "activity", state: "idle" }];
        if (raw.state === "requires_action") return [{ type: "activity", state: "needs_input" }];
        return [];
      }
      case "commands_changed":
        return [{ type: "info", patch: { commands: parseCommands(raw.commands) } }];
      case "compact_boundary": {
        const meta = isRecord(raw.compact_metadata) ? raw.compact_metadata : {};
        const pre = num(meta.pre_tokens);
        const post = num(meta.post_tokens);
        const sizes = pre !== undefined && post !== undefined ? ` (${pre} → ${post} tokens)` : "";
        return [notice(raw, `Conversation compacted${sizes}`, "info")];
      }
      case "local_command_output":
        return [notice(raw, str(raw.content) ?? "", "info")];
      default:
        return [];
    }
  }

  private stream(event: unknown, parent: string | null): AgentUpdate[] {
    if (!isRecord(event)) return [];
    const conversation = parent ?? "";
    if (event.type === "message_start") {
      const message = isRecord(event.message) ? event.message : {};
      const id = str(message.id);
      if (id) this.streamingMessage.set(conversation, id);
      return [];
    }
    const messageId = this.streamingMessage.get(conversation);
    const index = num(event.index);
    if (!messageId || index === undefined) return [];
    const blocks = this.streamBlocks.get(messageId) ?? new Map<number, StreamBlock>();
    this.streamBlocks.set(messageId, blocks);

    if (event.type === "content_block_start") {
      const block = isRecord(event.content_block) ? event.content_block : {};
      const kind =
        block.type === "text" ? "assistant" : block.type === "thinking" ? "thinking" : null;
      if (!kind) return [];
      const id = `${messageId}:${index}`;
      blocks.set(index, { id, kind, finalized: false });
      const text = str(kind === "assistant" ? block.text : block.thinking) ?? "";
      return [{ type: "item", item: { kind, id, text, parentToolUseId: parent, streaming: true } }];
    }
    if (event.type === "content_block_delta") {
      const streamed = blocks.get(index);
      const delta = isRecord(event.delta) ? event.delta : {};
      if (!streamed || streamed.finalized) return [];
      const text =
        delta.type === "text_delta"
          ? str(delta.text)
          : delta.type === "thinking_delta"
            ? str(delta.thinking)
            : undefined;
      return text ? [{ type: "append", id: streamed.id, text }] : [];
    }
    return [];
  }

  /**
   * The id a finished text or thinking block takes: the streamed block it completes, if one is
   * still open (the CLI sends each finished block as its own assistant message, in stream order),
   * else a new stable id.
   */
  private finalBlockId(messageId: string, kind: StreamBlock["kind"]): string {
    const count = this.finalizedCount.get(messageId) ?? 0;
    this.finalizedCount.set(messageId, count + 1);
    const blocks = this.streamBlocks.get(messageId);
    if (blocks) {
      const open = [...blocks.entries()]
        .sort(([a], [b]) => a - b)
        .find(([, block]) => !block.finalized && block.kind === kind);
      if (open) {
        open[1].finalized = true;
        return open[1].id;
      }
    }
    return `${messageId}:final:${count}`;
  }

  private assistant(raw: Json, parent: string | null): AgentUpdate[] {
    const message = isRecord(raw.message) ? raw.message : {};
    const messageId = str(message.id) ?? str(raw.uuid) ?? crypto.randomUUID();
    const updates: AgentUpdate[] = [];
    for (const block of records(message.content)) {
      if (block.type === "text") {
        const text = str(block.text) ?? "";
        const id = this.finalBlockId(messageId, "assistant");
        if (text.trim() === "") continue;
        updates.push({
          type: "item",
          item: { kind: "assistant", id, text, parentToolUseId: parent },
        });
      } else if (block.type === "thinking") {
        const id = this.finalBlockId(messageId, "thinking");
        updates.push({
          type: "item",
          item: { kind: "thinking", id, text: str(block.thinking) ?? "", parentToolUseId: parent },
        });
      } else if (block.type === "tool_use" || block.type === "server_tool_use") {
        const id = str(block.id);
        if (!id) continue;
        updates.push({
          type: "item",
          item: {
            kind: "tool",
            id,
            name: str(block.name) ?? "tool",
            input: block.input,
            parentToolUseId: parent,
          },
        });
      }
    }
    const error = str(raw.error);
    if (error) updates.push(notice(raw, assistantErrorText(error), "error"));
    return updates;
  }

  private user(raw: Json, parent: string | null, fromHistory: boolean): AgentUpdate[] {
    const message = isRecord(raw.message) ? raw.message : {};
    const updates: AgentUpdate[] = [];
    for (const block of records(message.content)) {
      if (block.type !== "tool_result") continue;
      const toolUseId = str(block.tool_use_id);
      if (!toolUseId) continue;
      updates.push({
        type: "tool_result",
        toolUseId,
        result: { text: toolResultText(block.content), isError: block.is_error === true },
      });
    }
    if (updates.length > 0) return updates;

    const uuid = str(raw.uuid);
    if (raw.isReplay === true && uuid) return [{ type: "user_delivered", uuid }];
    if (!fromHistory || parent !== null || raw.isSynthetic === true) return [];
    const { text, imageCount } = userText(message.content);
    if (CLI_GENERATED_USER_TEXT.test(text) || (text.trim() === "" && imageCount === 0)) return [];
    return [
      { type: "item", item: { kind: "user", id: uuid ?? crypto.randomUUID(), text, imageCount } },
    ];
  }

  private result(raw: Json): AgentUpdate[] {
    // Anything still streaming is as complete as it will get.
    this.streamingMessage.clear();
    const failed = raw.subtype !== "success" || raw.is_error === true;
    const errors = Array.isArray(raw.errors) ? raw.errors.filter((e) => typeof e === "string") : [];
    const error = failed ? errors.join("\n") || str(raw.result) || String(raw.subtype) : null;
    return [{ type: "turn_end", error, costUsd: num(raw.total_cost_usd) ?? null }];
  }
}

function notice(raw: Json, text: string, tone: "info" | "error"): AgentUpdate {
  return {
    type: "item",
    item: { kind: "notice", id: str(raw.uuid) ?? crypto.randomUUID(), text, tone },
  };
}

function assistantErrorText(error: string): string {
  switch (error) {
    case "authentication_failed":
      return "Claude is not signed in. Run `claude auth login` in a terminal, then resume.";
    case "rate_limit":
      return "Usage limit reached.";
    default:
      return `Claude reported an error: ${error}`;
  }
}
