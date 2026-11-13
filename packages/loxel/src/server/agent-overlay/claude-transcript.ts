/**
 * Claude Code's transcript (the JSONL file its hooks name as `transcript_path`): decoding records
 * into overlay transcript items, and following the file as Claude appends to it. Records the
 * overlay does not show (attachments, request blobs, file snapshots) are skipped; unknown record
 * types are skipped too, so a new Claude Code version adds nothing rather than breaking.
 */
import { closeSync, openSync, readSync, statSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";

import type {
  AgentJson,
  AgentPermissionMode,
  AgentToolResult,
  AgentTranscriptItem,
} from "@/api/agent-overlay-model";
import { AgentPermissionModeSchema } from "@/api/agent-overlay-model";

/** What one record contributes. */
export interface TranscriptUpdate {
  items: AgentTranscriptItem[];
  /** Results for tool uses seen earlier, by tool use ID. */
  toolResults: { id: string; result: AgentToolResult }[];
  /** Output of the local command (`/context`, `/cost`) run just before. */
  commandOutput: string | null;
  title: string | null;
  permissionMode: AgentPermissionMode | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

function json(value: unknown): AgentJson {
  // Parsed from JSON, so already a JSON value.
  return (value ?? null) as AgentJson;
}

/** A tool result's text: a string, or the text blocks of a content array. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const entry = record(block);
      if (entry?.type === "text") return str(entry.text) ?? "";
      if (entry?.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const tag = (text: string, name: string): string | null =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "u").exec(text)?.[1]?.trim() ?? null;

function emptyUpdate(): TranscriptUpdate {
  return { items: [], toolResults: [], commandOutput: null, title: null, permissionMode: null };
}

function decodeUserText(uuid: string, text: string, timestamp: string | null): TranscriptUpdate {
  const update = emptyUpdate();
  const name = tag(text, "command-name");
  if (name) {
    const args = tag(text, "command-args") ?? "";
    update.items.push({ kind: "command", id: uuid, name, args, output: null });
    return update;
  }
  const stdout = tag(text, "local-command-stdout");
  if (stdout !== null) {
    update.commandOutput = stdout;
    return update;
  }
  if (/^<local-command-caveat>/u.test(text) || /^<system-reminder>/u.test(text)) return update;
  if (/^\[Request interrupted by user/u.test(text)) {
    update.items.push({ kind: "system", id: uuid, text: "Interrupted" });
    return update;
  }
  update.items.push({ kind: "user", id: uuid, text, timestamp });
  return update;
}

/** One transcript record, already parsed from its JSONL line. */
export function decodeTranscriptRecord(value: unknown): TranscriptUpdate {
  const update = emptyUpdate();
  const entry = record(value);
  if (!entry) return update;
  const type = str(entry.type);
  if (type === "ai-title") {
    update.title = str(entry.aiTitle);
    return update;
  }
  if (type === "permission-mode") {
    const mode = AgentPermissionModeSchema.safeParse(entry.permissionMode);
    update.permissionMode = mode.success ? mode.data : null;
    return update;
  }
  const uuid = str(entry.uuid);
  if (!uuid) return update;
  if (type === "system") {
    if (entry.subtype === "compact_boundary") {
      update.items.push({ kind: "system", id: uuid, text: "Conversation compacted" });
    }
    return update;
  }
  // Subagents' own turns live in their own transcripts; meta records are prompts Claude adds.
  if (
    (type !== "user" && type !== "assistant") ||
    entry.isSidechain === true ||
    entry.isMeta === true
  ) {
    return update;
  }
  const message = record(entry.message);
  const timestamp = str(entry.timestamp);
  const content = message?.content;
  if (type === "user" && typeof content === "string")
    return decodeUserText(uuid, content, timestamp);
  if (!Array.isArray(content)) return update;

  const userText: string[] = [];
  for (const [index, raw] of content.entries()) {
    const block = record(raw);
    if (!block) continue;
    const id = `${uuid}:${index}`;
    switch (block.type) {
      case "text": {
        const text = str(block.text) ?? "";
        if (type === "assistant") {
          if (text.trim()) update.items.push({ kind: "assistant", id, text, timestamp });
        } else {
          userText.push(text);
        }
        break;
      }
      case "thinking": {
        const text = str(block.thinking) ?? "";
        if (text.trim()) update.items.push({ kind: "thinking", id, text });
        break;
      }
      case "tool_use": {
        const toolId = str(block.id);
        if (toolId) {
          update.items.push({
            kind: "tool",
            id: toolId,
            name: str(block.name) ?? "tool",
            input: json(block.input),
            result: null,
          });
        }
        break;
      }
      case "tool_result": {
        const toolId = str(block.tool_use_id);
        if (toolId) {
          update.toolResults.push({
            id: toolId,
            result: { text: resultText(block.content), isError: block.is_error === true },
          });
        }
        break;
      }
      case "image":
        if (type === "user") userText.push("[image]");
        break;
      default:
        break;
    }
  }
  if (userText.length > 0) {
    const text = userText.join("\n");
    const decoded = decodeUserText(uuid, text, timestamp);
    update.items.push(...decoded.items);
    update.commandOutput ??= decoded.commandOutput;
  }
  return update;
}

/**
 * The transcript as items, folding tool results into their tool items and command output into
 * the command item it follows. Keeps the order items first appeared in.
 */
export class TranscriptModel {
  private readonly items = new Map<string, AgentTranscriptItem>();
  private lastCommandId: string | null = null;
  title: string | null = null;
  permissionMode: AgentPermissionMode | null = null;

  /** Applies one record; returns the items it added or changed. */
  apply(value: unknown): AgentTranscriptItem[] {
    const update = decodeTranscriptRecord(value);
    const changed: AgentTranscriptItem[] = [];
    if (update.title) this.title = update.title;
    if (update.permissionMode) this.permissionMode = update.permissionMode;
    for (const item of update.items) {
      this.items.set(item.id, item);
      changed.push(item);
      if (item.kind === "command") this.lastCommandId = item.id;
      else if (item.kind === "user") this.lastCommandId = null;
    }
    for (const { id, result } of update.toolResults) {
      const tool = this.items.get(id);
      if (tool?.kind !== "tool") continue;
      const updated = { ...tool, result };
      this.items.set(id, updated);
      changed.push(updated);
    }
    if (update.commandOutput !== null && this.lastCommandId) {
      const command = this.items.get(this.lastCommandId);
      if (command?.kind === "command") {
        const updated = { ...command, output: update.commandOutput };
        this.items.set(command.id, updated);
        changed.push(updated);
      }
    }
    return changed;
  }

  all(): AgentTranscriptItem[] {
    return [...this.items.values()];
  }
}

const READ_CHUNK = 1 << 20;

/**
 * Follows a transcript file: reads what is there, then what Claude appends, calling `onRecords`
 * with each batch of complete lines parsed as JSON (a line Claude is still writing waits for its
 * newline; an unparsable one is skipped). A file replaced under the same path (a new inode) or
 * truncated is read again from the start, with `reset` set.
 */
export class TranscriptTailer {
  private offset = 0;
  private inode: number | null = null;
  private partial: Buffer = Buffer.alloc(0);
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    readonly path: string,
    private readonly onRecords: (records: unknown[], reset: boolean) => void,
    private readonly pollMs = 1_000,
  ) {}

  start(): void {
    this.read();
    try {
      this.watcher = watch(this.path, () => this.read());
    } catch {
      // Not created yet (a session that has not written), or not watchable: the poll covers it.
    }
    // fs.watch can miss appends on some filesystems; a slow poll is the backstop.
    this.timer = setInterval(() => this.read(), this.pollMs);
  }

  stop(): void {
    this.closed = true;
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
  }

  /** Reads everything appended since the last read. */
  read(): void {
    if (this.closed) return;
    let reset = false;
    const chunks: Buffer[] = [];
    try {
      const stats = statSync(this.path);
      if (this.inode !== null && (stats.ino !== this.inode || stats.size < this.offset)) {
        this.offset = 0;
        this.partial = Buffer.alloc(0);
        reset = true;
      }
      this.inode = stats.ino;
      if (stats.size <= this.offset && !reset) return;
      const fd = openSync(this.path, "r");
      try {
        while (this.offset < stats.size) {
          const buffer = Buffer.alloc(Math.min(READ_CHUNK, stats.size - this.offset));
          const read = readSync(fd, buffer, 0, buffer.length, this.offset);
          if (read <= 0) break;
          this.offset += read;
          chunks.push(buffer.subarray(0, read));
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      // Not there yet, or replaced between the stat and the open: the next read catches up.
      if (chunks.length === 0 && !reset) return;
    }
    // Split on newline bytes, so a multibyte character the writer is midway through stays whole.
    const bytes = Buffer.concat([this.partial, ...chunks]);
    const lastNewline = bytes.lastIndexOf(0x0a);
    this.partial = Buffer.from(bytes.subarray(lastNewline + 1));
    const records: unknown[] = [];
    for (const line of bytes
      .subarray(0, lastNewline + 1)
      .toString("utf8")
      .split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // A corrupt line; the rest of the transcript still reads.
      }
    }
    if (records.length > 0 || reset) this.onRecords(records, reset);
  }
}
