/**
 * The terminals coding agents asked for while "When an Agent Starts a Terminal" is Ask: the
 * requests waiting for the user's answer, and the worktrees the user answered "Always in this
 * worktree" for. The requests are kept in memory only: they hold the command, which Loxel never
 * writes to disk, and a request a restart drops is one the agent can make again. See
 * docs/TERMINALS.md#agent-terminals.
 */
import { z } from "zod";

import type { AgentTerminalAsk, AgentTerminalsState } from "@/api/agent-terminal-model";
import type { PanelOpenOptions } from "@/api/panel-placement-model";

import { logger } from "./logger";

const log = logger.child("server");

/** Like the open inbox: enough for a night of agents, while a runaway loop cannot grow it. */
const MAX_ASKS = 100;
/** Like the open inbox: an unanswered request older than this is stale, its agent long gone. */
const ASK_TTL_MS = 72 * 60 * 60_000;

/**
 * A request as kept: what the window shows, plus where the panel goes once it runs, and the window
 * it was first asked in (`homeWindowId`), which takes it back when it reconnects after a reload.
 */
export type StoredAsk = AgentTerminalAsk & PanelOpenOptions & { homeWindowId?: string };

const AlwaysWorktreesSchema = z.array(z.string());

interface AgentTerminalsOptions {
  /** The JSON {@link AgentTerminalsOptions.saveAlways} last wrote, if any. */
  loadAlways: () => string | null;
  saveAlways: (json: string) => void;
  /** What windows show changed. */
  onChange: (state: AgentTerminalsState) => void;
  now?: () => number;
}

export class AgentTerminals {
  private asks: StoredAsk[] = [];
  private readonly always: Set<string>;
  private readonly now: () => number;

  constructor(private readonly options: AgentTerminalsOptions) {
    this.now = options.now ?? Date.now;
    this.always = new Set(readAlways(options.loadAlways));
  }

  /** What windows show. */
  state(): AgentTerminalsState {
    this.expire();
    return {
      asks: this.asks.map(
        ({ placement: _placement, focus: _focus, homeWindowId: _home, ...ask }) => ask,
      ),
      alwaysWorktrees: [...this.always],
    };
  }

  /** Keep a request for the user to answer. Returns null, keeping nothing, when too many wait. */
  ask(request: Omit<StoredAsk, "id" | "askedAt">): StoredAsk | null {
    this.expire();
    if (this.asks.length >= MAX_ASKS) return null;
    const ask: StoredAsk = {
      ...request,
      id: crypto.randomUUID(),
      askedAt: this.now(),
      ...(request.windowId ? { homeWindowId: request.windowId } : {}),
    };
    this.asks.push(ask);
    this.publish();
    return ask;
  }

  /** Take the request `id` to act on the user's answer; null when it was answered or expired. */
  take(id: string): StoredAsk | null {
    const expired = this.expire();
    const ask = this.asks.find((candidate) => candidate.id === id);
    if (!ask) {
      // The windows may still show one that expired.
      if (expired) this.publish();
      return null;
    }
    this.drop([ask]);
    return ask;
  }

  /** Whether the user chose "Always in this worktree" for `worktreePath`. */
  runsAlways(worktreePath: string | null): boolean {
    return worktreePath !== null && this.always.has(worktreePath);
  }

  /** Stop asking for `worktreePath`'s agents' terminals. */
  runAlways(worktreePath: string): void {
    if (this.always.has(worktreePath)) return;
    this.always.add(worktreePath);
    this.saveAlways();
    this.publish();
  }

  /** Ask again in every worktree (Settings > Terminal). */
  clearAlways(): void {
    if (this.always.size === 0) return;
    this.always.clear();
    this.saveAlways();
    this.publish();
  }

  /**
   * A window said hello: it takes back the requests first asked in it (moved to another window
   * while it reloaded), and those whose window is gone or that came while none was connected.
   */
  windowConnected(windowId: string, isConnected: (windowId: string) => boolean): void {
    this.reassign(
      (ask) => ask.homeWindowId === windowId || !ask.windowId || !isConnected(ask.windowId),
      windowId,
    );
  }

  /**
   * A window closed: its requests move to `windowInUse`, or, with none, wait for the next window
   * to say hello.
   */
  windowClosed(isConnected: (windowId: string) => boolean, windowInUse: string | null): void {
    this.reassign((ask) => !ask.windowId || !isConnected(ask.windowId), windowInUse);
  }

  /** Requests for the same worktree as `worktreePath`, taken to run with it ("Always"). */
  takeWorktree(worktreePath: string): StoredAsk[] {
    this.expire();
    const taken = this.asks.filter((ask) => ask.worktreePath === worktreePath);
    if (taken.length > 0) this.drop(taken);
    return taken;
  }

  /** A worktree moved (`wt mv`): its requests and its choice to always run follow it. */
  moveWorktree(from: string, to: string): void {
    const asks = this.asks.filter((ask) => ask.worktreePath === from);
    for (const ask of asks) ask.worktreePath = to;
    const wasAlways = this.always.delete(from);
    if (wasAlways) {
      this.always.add(to);
      this.saveAlways();
    }
    if (asks.length > 0 || wasAlways) this.publish();
  }

  /** Forget a removed worktree: its requests, and the choice to always run there. */
  dropWorktree(worktreePath: string): void {
    const dropped = this.asks.filter((ask) => ask.worktreePath === worktreePath);
    const wasAlways = this.always.delete(worktreePath);
    if (wasAlways) this.saveAlways();
    if (dropped.length > 0) this.drop(dropped);
    else if (wasAlways) this.publish();
  }

  private reassign(matches: (ask: StoredAsk) => boolean, windowId: string | null): void {
    const moved = this.asks.filter(
      (ask) => matches(ask) && ask.windowId !== (windowId ?? undefined),
    );
    if (moved.length === 0) return;
    for (const ask of moved) {
      if (windowId) ask.windowId = windowId;
      else delete ask.windowId;
      // The first window to ask is the one that takes it back after a reload.
      if (!ask.homeWindowId && windowId) ask.homeWindowId = windowId;
    }
    this.publish();
  }

  private drop(asks: readonly StoredAsk[]): void {
    const ids = new Set(asks.map((ask) => ask.id));
    this.asks = this.asks.filter((ask) => !ids.has(ask.id));
    this.publish();
  }

  /** Drop the requests past their time; returns whether there were any. */
  private expire(): boolean {
    const cutoff = this.now() - ASK_TTL_MS;
    const count = this.asks.length;
    this.asks = this.asks.filter((ask) => ask.askedAt >= cutoff);
    return this.asks.length < count;
  }

  private saveAlways(): void {
    this.options.saveAlways(JSON.stringify([...this.always]));
  }

  private publish(): void {
    this.options.onChange(this.state());
  }
}

function readAlways(load: () => string | null): string[] {
  const raw = load();
  if (raw === null) return [];
  try {
    const parsed = AlwaysWorktreesSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // Falls through to the warning below.
  }
  log.warn("Ignoring unreadable agent terminal worktrees");
  return [];
}
