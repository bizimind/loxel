/**
 * The open inbox: what `loxel` asked to open while no window was connected, kept until a window
 * has placed its panel. See docs/TERMINALS.md#the-open-inbox.
 */
import { basename } from "node:path";

import { z } from "zod";

import { parsePanelPlacement } from "@/api/panel-placement-model";
import type { WsMessage } from "@/api/ws-protocol";

import { PersistedList } from "./persisted-list";

/** The requests the inbox holds: the messages `POST /api/open` sends a window. */
export type InboxMessage = Extract<
  WsMessage,
  { type: "open_file" | "open_folder" | "open_terminal" | "open_url" }
>;

/**
 * Enough for a burst of agents' requests over a night away, while a runaway loop cannot grow the
 * inbox, or the panels a window gets on connecting, without bound.
 */
const MAX_ENTRIES = 100;
/**
 * A request older than this is stale: it covers a weekend away, and whoever asked has moved on
 * after that. A queued terminal whose request expires is an orphan like any other.
 */
const ENTRY_TTL_MS = 72 * 60 * 60_000;

const PlacementSchema = z.unknown().transform((value, ctx) => {
  try {
    return parsePanelPlacement(value);
  } catch (err) {
    ctx.addIssue({ code: "custom", message: err instanceof Error ? err.message : String(err) });
    return z.NEVER;
  }
});
const openOptions = { placement: PlacementSchema.optional(), focus: z.boolean().optional() };

const InboxMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("open_file"),
    data: z.object({ filePath: z.string(), worktreePath: z.string().optional(), ...openOptions }),
  }),
  z.object({ type: z.literal("open_folder"), data: z.object({ path: z.string() }) }),
  z.object({
    type: z.literal("open_terminal"),
    data: z.object({
      terminalId: z.string(),
      cwd: z.string(),
      worktreePath: z.string().nullable(),
      title: z.string().optional(),
      ...openOptions,
    }),
  }),
  z.object({
    type: z.literal("open_url"),
    wtPath: z.string().nullable(),
    data: z.object({ url: z.string(), ...openOptions }),
  }),
]) satisfies z.ZodType<InboxMessage>;

/**
 * Both ways: a field added to the messages must be added here too, or a restart would strip it from
 * the requests read back.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const schemaMatchesMessages: Same<z.output<typeof InboxMessageSchema>, InboxMessage> = true;
void schemaMatchesMessages;

const InboxEntrySchema = z.object({
  id: z.string(),
  queuedAt: z.number(),
  /** The worktree the panel opens in, null for Home, or absent for whatever the window shows. */
  worktreePath: z.string().nullable().optional(),
  message: InboxMessageSchema,
  /** A window got it (and a notification said so), but has not placed its panel yet. */
  delivered: z.boolean().optional(),
});
export type InboxEntry = z.infer<typeof InboxEntrySchema>;

interface OpenInboxOptions {
  /** The SQLite file to keep the inbox in; null keeps it in memory only. */
  path?: string | null;
  now?: () => number;
}

export class OpenInbox {
  private entries: InboxEntry[];
  private readonly persisted: PersistedList<InboxEntry>;
  private readonly now: () => number;

  constructor({ path = null, now = Date.now }: OpenInboxOptions = {}) {
    this.persisted = new PersistedList(path, InboxEntrySchema);
    this.now = now;
    this.entries = this.persisted.load();
    this.expire();
  }

  /** Queue `message` for the next window. Returns false, queueing nothing, when the inbox is full. */
  add(message: InboxMessage, worktreePath: string | null | undefined): boolean {
    if (!this.hasRoom()) return false;
    const entry: InboxEntry = {
      id: crypto.randomUUID(),
      queuedAt: this.now(),
      ...(worktreePath === undefined ? {} : { worktreePath }),
      message,
    };
    this.entries.push(entry);
    this.persisted.insert(entry);
    return true;
  }

  /** Whether another request fits. */
  hasRoom(): boolean {
    this.expire();
    return this.entries.length < MAX_ENTRIES;
  }

  /** Whether a request waits for a window to show the terminal `id`. */
  holdsTerminal(id: string): boolean {
    this.expire();
    return this.entries.some(
      ({ message }) => message.type === "open_terminal" && message.data.terminalId === id,
    );
  }

  /**
   * How long until the first request holding a terminal has expired (it is expired once strictly
   * older than the TTL), or null when none holds one.
   */
  msUntilTerminalExpires(): number | null {
    this.expire();
    const queuedAt = this.entries
      .filter(({ message }) => message.type === "open_terminal")
      .map((entry) => entry.queuedAt);
    if (queuedAt.length === 0) return null;
    return Math.min(...queuedAt) + ENTRY_TTL_MS + 1 - this.now();
  }

  /** Every request still current, oldest first. */
  list(): readonly InboxEntry[] {
    this.expire();
    return this.entries;
  }

  /** Remember that a window got the requests `ids`, so they are not announced again. */
  markDelivered(ids: readonly string[]): void {
    const marked = new Set(ids);
    for (const entry of this.entries) {
      if (!marked.has(entry.id) || entry.delivered) continue;
      entry.delivered = true;
      this.persisted.insert(entry);
    }
  }

  /** A window placed the request's panel: it is done with. */
  remove(id: string): void {
    this.dropWhere((entry) => entry.id === id);
  }

  /**
   * Drop the requests that match: a removed worktree's, or a terminal's whose session is gone, which
   * a panel would only show as a new shell.
   */
  dropWhere(matches: (entry: InboxEntry) => boolean): void {
    const dropped = this.entries.filter(matches);
    if (dropped.length === 0) return;
    this.entries = this.entries.filter((entry) => !matches(entry));
    this.persisted.delete(dropped.map((entry) => entry.id));
  }

  get size(): number {
    return this.entries.length;
  }

  close(): void {
    this.persisted.close();
  }

  private expire(): void {
    const cutoff = this.now() - ENTRY_TTL_MS;
    this.dropWhere((entry) => entry.queuedAt < cutoff);
  }
}

/**
 * Destroy the orphaned terminals no request in `inbox` holds, with `destroyOrphans` (the terminal
 * manager's), and say when to sweep again: just after the first request holding one expires, which
 * makes its terminal an ordinary orphan; null when no request holds one.
 */
export function sweepOrphans(
  inbox: OpenInbox,
  destroyOrphans: (kept: (id: string) => boolean) => number,
): { destroyed: number; nextSweepInMs: number | null } {
  const destroyed = destroyOrphans((id) => inbox.holdsTerminal(id));
  return { destroyed, nextSweepInMs: inbox.msUntilTerminalExpires() };
}

/** What a request opens, for the notification that says it did. */
type OpenKind = "terminal" | "file" | "folder" | "page";

function openKind(message: InboxMessage): OpenKind {
  switch (message.type) {
    case "open_terminal":
      return "terminal";
    case "open_file":
      return "file";
    case "open_folder":
      return "folder";
    case "open_url":
      return "page";
    default: {
      const unknown: never = message;
      throw new Error(`Unknown inbox message: ${String(unknown)}`);
    }
  }
}

/** A short name for what a request opens: a terminal's title, a file's name, a page's host. */
function openName(message: InboxMessage): string | null {
  switch (message.type) {
    case "open_terminal":
      return message.data.title ?? null;
    case "open_file":
      return basename(message.data.filePath);
    case "open_folder":
      return basename(message.data.path);
    case "open_url":
      return URL.parse(message.data.url)?.host ?? null;
    default: {
      const unknown: never = message;
      throw new Error(`Unknown inbox message: ${String(unknown)}`);
    }
  }
}

const ORDER: readonly OpenKind[] = ["terminal", "file", "folder", "page"];
const MAX_NAMES = 5;

/** "2 terminals and a file", "3 pages". */
function countPhrase(counts: Map<OpenKind, number>): string {
  const parts = ORDER.flatMap((kind) => {
    const count = counts.get(kind);
    if (!count) return [];
    return [count === 1 ? `A ${kind}` : `${count} ${kind}s`];
  }).map((part, index) => (index === 0 ? part : part.replace(/^A /, "a ")));
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** The notifications to raise for requests delivered at once: one per worktree (or Home). */
export function deliveredNotices(
  entries: readonly InboxEntry[],
): Array<{ worktreePath?: string | null; title: string; body?: string }> {
  const groups = Map.groupBy(entries, (entry) => entry.worktreePath);
  return [...groups].map(([worktreePath, group]) => {
    const counts = new Map<OpenKind, number>();
    for (const { message } of group) {
      const kind = openKind(message);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    const names = [...new Set(group.flatMap(({ message }) => openName(message) ?? []))];
    const shown = names.slice(0, MAX_NAMES).join(", ");
    const more = names.length > MAX_NAMES ? ` and ${names.length - MAX_NAMES} more` : "";
    return {
      ...(worktreePath === undefined ? {} : { worktreePath }),
      title: `${countPhrase(counts)} opened while you were away`,
      ...(names.length > 0 ? { body: shown + more } : {}),
    };
  });
}
