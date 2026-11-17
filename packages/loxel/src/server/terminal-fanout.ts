/**
 * The clients attached to one terminal session, fed by the session's one attachment in the
 * terminal host: which client is active (the PTY has its size, and only its input is written),
 * each client's sync and flow control, and the host's states and output fanned out to them. See
 * docs/TERMINALS.md#several-clients.
 */
import { clampTerminalSize } from "@/api/terminal-limits";
import type { TerminalState } from "@/api/terminal-stream";
import type { TerminalEnd, TerminalNotice } from "@/api/ws-protocol";
import type { TerminalOutputEvent } from "@/terminal-host";

import { logger } from "./logger";

const log = logger.child("terminal");

export type TerminalOutput = Omit<TerminalOutputEvent, "type" | "id">;

export type TerminalSize = ReturnType<typeof clampTerminalSize>;

/** Where a session delivers messages for one attached client. */
export interface TerminalSink {
  sendState(state: TerminalState): void;
  /** Output from the host, with the renderer frame to forward as is. */
  sendOutput(output: TerminalOutput): void;
  sendExit(end: TerminalEnd): void;
  sendNotice(notice: TerminalNotice): void;
  /**
   * The PTY's size, which another client set or joined at: every client but the active one renders
   * at it.
   */
  sendSize(size: TerminalSize): void;
}

/** A client's flow-control budget: unacknowledged bytes that pause it, and that resync it. */
export interface FlowControl {
  highWaterBytes: number;
  lowWaterBytes: number;
}

interface StreamPoint {
  epoch: string;
  offset: number;
}

/** What a client's acknowledgement calls for. */
export interface AckOutcome {
  /** The client caught up after a pause and waits for a snapshot. */
  resync: boolean;
  /** Bytes to acknowledge to the host under its sync at `syncOffset`, if any. */
  hostAck: { syncOffset: number; bytes: number } | null;
}

interface Client {
  /**
   * `waiting` for a state (just attached, or caught up after a pause); `live`, receiving output;
   * `paused`, too far behind to be sent more until its acks catch up.
   */
  status: "waiting" | "live" | "paused";
  /** Where a waiting client's xterm is already current to, if it has one. */
  since: StreamPoint | undefined;
  /** Offset of the state the client is working under; its acks quote it. */
  syncOffset: number;
  unacked: number;
  /** The stream offset the client has parsed up to, by its acks. */
  parsed: number;
}

export class TerminalFanout {
  /** In the order they attached. */
  private readonly clients = new Map<TerminalSink, Client>();
  /**
   * The client whose input is written, and, when it claimed the terminal or attached alone, whose
   * size the PTY has. Once it leaves, the most recently attached client takes its input over.
   */
  private active: TerminalSink | null = null;
  /** The PTY's size: the latest the active client asked for, clamped as the host clamps it. */
  private size: TerminalSize;
  /** Where the live clients are in the stream; null until the host attachment's first state. */
  private offset: number | null = null;
  /** Offset of the host attachment's latest state, which acks to the host quote. */
  private hostSyncOffset = 0;
  /** The stream offset acknowledged to the host under that state. */
  private hostAcked = 0;

  constructor(
    private readonly id: string,
    size: TerminalSize,
    private readonly flow: FlowControl,
  ) {
    this.size = size;
  }

  get ptySize(): TerminalSize {
    return this.size;
  }

  get attached(): boolean {
    return this.clients.size > 0;
  }

  has(sink: TerminalSink): boolean {
    return this.clients.has(sink);
  }

  isWaiting(sink: TerminalSink): boolean {
    return this.clients.get(sink)?.status === "waiting";
  }

  isActive(sink: TerminalSink): boolean {
    return this.active === sink;
  }

  /**
   * Add `sink`, replacing any earlier attach of it, as a client waiting for its state, from
   * `since` if its xterm is current to that point. With no other client attached it becomes the
   * active client, at `size`. Otherwise it joins passive, at the PTY's size, which it is sent:
   * opening a terminal another window uses must not reflow it there, so it claims only on its
   * user's input. Returns whether the PTY's size changed.
   */
  attach(sink: TerminalSink, size: TerminalSize, since?: StreamPoint): boolean {
    this.clients.delete(sink);
    const alone = this.clients.size === 0;
    this.clients.set(sink, { status: "waiting", since, syncOffset: 0, unacked: 0, parsed: 0 });
    if (alone) {
      this.active = sink;
      return this.setSize(size, true);
    }
    sink.sendSize(this.size);
    return false;
  }

  /**
   * `sink` resized its view, or its user typed, clicked or focused it: it becomes the active
   * client, at `size`. Returns whether the PTY's size changed; a sink not attached changes nothing.
   */
  claim(sink: TerminalSink, size: TerminalSize): boolean {
    if (!this.clients.has(sink)) return false;
    const activeChanged = !this.isActive(sink);
    this.active = sink;
    return this.setSize(size, activeChanged);
  }

  /**
   * Remove `sink`; returns whether it was attached. When it was the active client, the most
   * recently attached one takes its input over silently, which is not a claim: the PTY keeps its
   * size, which that one already renders at, and nobody is told or resized, so a window leaving
   * (or switching worktree and back) reflows nothing, while exactly one xterm still answers the
   * program's terminal queries. Its user's input claims the terminal as usual. Once the last
   * client is gone the stream starts over with the next attach.
   */
  detach(sink: TerminalSink): boolean {
    if (!this.clients.delete(sink)) return false;
    if (this.active === sink) this.active = [...this.clients.keys()].at(-1) ?? null;
    if (this.clients.size === 0) this.offset = null;
    return true;
  }

  private setSize(requested: TerminalSize, activeChanged: boolean): boolean {
    const size = clampTerminalSize(requested.cols, requested.rows);
    const changed = size.cols !== this.size.cols || size.rows !== this.size.rows;
    this.size = size;
    if (changed || activeChanged) {
      for (const sink of this.clients.keys()) {
        if (!this.isActive(sink)) sink.sendSize(size);
      }
    }
    return changed;
  }

  /** Whether a client waits for a state, which only a new host attachment gives it. */
  needsSync(): boolean {
    return [...this.clients.values()].some((client) => client.status === "waiting");
  }

  /**
   * Where a new host attachment should resume from: the point every waiting client is current to,
   * when they share one and no client is live, which a resume would not suit. Otherwise the host
   * sends a snapshot, which serves them all.
   */
  resumePoint(): StreamPoint | undefined {
    const clients = [...this.clients.values()];
    if (clients.some((client) => client.status === "live")) return undefined;
    const points = clients.filter((c) => c.status === "waiting").map((c) => c.since);
    const [first] = points;
    const shared = points.every((p) => p?.epoch === first?.epoch && p?.offset === first?.offset);
    return shared ? first : undefined;
  }

  /**
   * A state of the host attachment. A live client already at its offset carries on untouched;
   * the others are synced with it, or wait for the next if it is a resume from a point they are not
   * at. A paused client gets only a resync the host made on its own (`requested` false: its flow
   * control, the final one before an exit, a restored connection), and otherwise waits to catch up.
   */
  applyState(state: TerminalState, requested: boolean): void {
    for (const [sink, client] of this.clients) {
      if (client.status === "live" && this.offset === state.offset) continue;
      if (client.status === "paused" && requested) continue;
      const resumable =
        client.status === "waiting" &&
        client.since?.epoch === state.epoch &&
        client.since.offset === state.offset;
      if (state.mode === "resume" && !resumable) {
        client.status = "waiting";
        continue;
      }
      client.status = "live";
      client.since = undefined;
      client.syncOffset = state.offset;
      client.unacked = 0;
      client.parsed = state.offset;
      sink.sendState(state);
    }
    this.offset = state.offset;
    this.hostSyncOffset = state.offset;
    this.hostAcked = state.offset;
  }

  /** Output of the host attachment, sent to every live client. */
  forward(output: TerminalOutput): void {
    // Before the attachment's first state: the tail of one dropped when its last client left.
    if (this.offset === null) return;
    const bytes = output.data.byteLength;
    this.offset = output.offset + bytes;
    for (const [sink, client] of this.clients) {
      if (client.status !== "live") continue;
      // Counted before it is sent: a client in this process can acknowledge it before
      // `sendOutput` returns, and an ack applied first would be lost, pausing one that keeps up.
      client.unacked += bytes;
      sink.sendOutput(output);
      if (client.status === "live" && client.unacked > this.flow.highWaterBytes) {
        client.status = "paused";
        const behind = `${client.unacked} bytes behind`;
        log.info(`Terminal ${this.id.slice(0, 8)} client is ${behind}, pausing its output`);
      }
    }
  }

  /**
   * Flow control: the client has parsed `bytes` more bytes under the sync at `syncOffset`. The
   * host is acknowledged as far as the furthest client has parsed, so it pauses only when every
   * client is behind, as with a single slow client.
   */
  ack(sink: TerminalSink, syncOffset: number, bytes: number): AckOutcome {
    const none: AckOutcome = { resync: false, hostAck: null };
    const client = this.clients.get(sink);
    if (!client || client.status === "waiting" || syncOffset !== client.syncOffset) return none;
    client.unacked = Math.max(0, client.unacked - bytes);
    client.parsed = Math.min(client.parsed + bytes, this.offset ?? client.parsed);
    const resync = client.status === "paused" && client.unacked <= this.flow.lowWaterBytes;
    if (resync) client.status = "waiting";
    const furthest = Math.max(...[...this.clients.values()].map((c) => c.parsed));
    if (furthest <= this.hostAcked) return { resync, hostAck: null };
    const hostAck = { syncOffset: this.hostSyncOffset, bytes: furthest - this.hostAcked };
    this.hostAcked = furthest;
    return { resync, hostAck };
  }

  sendExit(end: TerminalEnd): void {
    for (const sink of this.clients.keys()) sink.sendExit(end);
  }

  sendNotice(notice: TerminalNotice): void {
    for (const sink of this.clients.keys()) sink.sendNotice(notice);
  }
}
