/**
 * One terminal session: a PTY-backed shell plus a server-side headless xterm that is the source
 * of truth for the screen, scrollback, size and modes. A client attaches to receive either a
 * snapshot of that emulator or, if its own xterm is still current, the output it missed, and then
 * the live stream. Raw history is never replayed into a fresh xterm, so terminal queries, bells and
 * notifications in old output never fire a second time. See docs/TERMINALS.md.
 */
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { Subprocess } from "bun";

import type { NotificationSequence, TerminalState } from "@/api/ws-protocol";
import { clampScrollbackLines, clampTerminalSize } from "@/api/ws-protocol";
import type { OscPayload } from "@/lib/osc-notification-parser";
import { parseOsc777, parseOsc9, parseOsc99 } from "@/lib/osc-notification-parser";

import { logger } from "./logger";
import { stress } from "./stress-detector";

const log = logger.child("terminal");

/** Bytes of recent output kept so a reconnecting client can resume without a snapshot. */
export const RESUME_RING_BYTES = 1024 * 1024;
/** Unacknowledged bytes above which output streaming to the client pauses. */
export const FLOW_HIGH_WATER_BYTES = 2 * 1024 * 1024;
/** Unacknowledged bytes below which a paused client is brought back with a snapshot. */
export const FLOW_LOW_WATER_BYTES = 128 * 1024;

/** Where a session delivers messages for its attached client. */
export interface TerminalSink {
  sendState(state: TerminalState): void;
  sendOutput(offset: number, data: Uint8Array): void;
  sendExit(exitCode: number): void;
}

export interface TerminalSessionOptions {
  id: string;
  cols: number;
  rows: number;
  cwd: string;
  /** The worktree the panel belongs to; notifications are filed under it. Defaults to `cwd`. */
  worktreePath?: string;
  scrollbackLines?: number;
  env: Record<string, string | undefined>;
  /** Command to run in the PTY. Defaults to the user's login shell. */
  command?: string[];
  /** Enabled notification sequences; consulted when a sequence arrives. */
  isSequenceEnabled: (sequence: NotificationSequence) => boolean;
  onNotification: (session: TerminalSession, payload: OscPayload) => void;
  onExit: (session: TerminalSession, exitCode: number) => void;
  /** Overrides for tests. */
  resumeRingBytes?: number;
  flowControl?: { highWaterBytes: number; lowWaterBytes: number };
}

/** Handle returned by `OutputRing.pin()`; only its holder can release that pin. */
export interface RingPin {
  readonly offset: number;
}

/**
 * Recent output bytes indexed by absolute stream offset. Chunks are evicted oldest-first once the
 * capacity is exceeded; the newest chunk, and everything at or after the oldest pinned offset, is
 * always retained.
 */
export class OutputRing {
  private chunks: { offset: number; data: Uint8Array }[] = [];
  private bytes = 0;
  private pins = new Set<RingPin>();
  /** Offset of the oldest retained byte. */
  start = 0;
  /** Offset one past the newest byte: the total number of bytes produced. */
  end = 0;

  constructor(private readonly capacity: number) {}

  push(data: Uint8Array): void {
    this.chunks.push({ offset: this.end, data });
    this.end += data.byteLength;
    this.bytes += data.byteLength;
    const pinnedFrom = this.pinnedFrom();
    while (this.bytes > this.capacity && this.chunks.length > 1) {
      const oldest = this.chunks[0]!;
      if (pinnedFrom !== null && oldest.offset + oldest.data.byteLength > pinnedFrom) break;
      this.chunks.shift();
      this.bytes -= oldest.data.byteLength;
      this.start = this.chunks[0]!.offset;
    }
  }

  /**
   * Keep every byte from `offset` on, regardless of capacity, until the returned pin is released.
   * Used while a snapshot at `offset` is being produced so the bytes after it can always be
   * streamed. Pins are independent: overlapping snapshots each hold their own.
   */
  pin(offset: number): RingPin {
    const pin: RingPin = { offset };
    this.pins.add(pin);
    return pin;
  }

  unpin(pin: RingPin): void {
    this.pins.delete(pin);
  }

  /** Oldest pinned offset, or null when nothing is pinned. */
  private pinnedFrom(): number | null {
    let min: number | null = null;
    for (const pin of this.pins) {
      if (min === null || pin.offset < min) min = pin.offset;
    }
    return min;
  }

  /** Every byte from `offset` to the end, or null if any of them has been evicted. */
  readFrom(offset: number): Uint8Array | null {
    if (offset < this.start || offset > this.end) return null;
    const out = new Uint8Array(this.end - offset);
    let pos = 0;
    for (const chunk of this.chunks) {
      const chunkEnd = chunk.offset + chunk.data.byteLength;
      if (chunkEnd <= offset) continue;
      const slice =
        chunk.offset >= offset ? chunk.data : chunk.data.subarray(offset - chunk.offset);
      out.set(slice, pos);
      pos += slice.byteLength;
    }
    return out;
  }
}

export class TerminalSession {
  readonly id: string;
  /** Identifies this spawn; a client may only resume with offsets it got under this epoch. */
  readonly epoch = crypto.randomUUID();
  readonly cwd: string;
  readonly worktreePath: string;
  cols: number;
  rows: number;
  /** Resolves with the shell's exit code once the process is gone. */
  readonly exited: Promise<number>;

  private readonly proc: Subprocess;
  private readonly emulator: HeadlessTerminal;
  private readonly serializer: SerializeAddon;
  private readonly ring: OutputRing;
  private readonly highWater: number;
  private readonly lowWater: number;

  /** The attached client, set as soon as `attach()` is called. */
  private sink: TerminalSink | null = null;
  /** True once the sink has been synced and receives live output. */
  private streaming = false;
  /** Offset of the state message the current sync started from; acks must quote it. */
  private syncOffset = 0;
  /** Resolvers of snapshots still waiting on the emulator; settled with "" on destroy. */
  private pendingSerializes = new Set<(snapshot: string) => void>();
  /** Invalidates in-flight snapshots when the client changes. */
  private attachGeneration = 0;
  private unacked = 0;
  private paused = false;
  private disposed = false;
  private emulatorOverflowed = false;

  constructor(private readonly options: TerminalSessionOptions) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.worktreePath = options.worktreePath ?? options.cwd;
    const size = clampTerminalSize(options.cols, options.rows);
    this.cols = size.cols;
    this.rows = size.rows;
    this.ring = new OutputRing(options.resumeRingBytes ?? RESUME_RING_BYTES);
    this.highWater = options.flowControl?.highWaterBytes ?? FLOW_HIGH_WATER_BYTES;
    this.lowWater = options.flowControl?.lowWaterBytes ?? FLOW_LOW_WATER_BYTES;

    this.emulator = new HeadlessTerminal({
      cols: size.cols,
      rows: size.rows,
      scrollback: clampScrollbackLines(options.scrollbackLines),
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.emulator.loadAddon(this.serializer);
    this.registerNotificationHandlers();

    const command = options.command ?? [process.env.SHELL || "/bin/bash", "-il"];
    this.proc = Bun.spawn(command, {
      cwd: options.cwd,
      env: options.env,
      terminal: {
        cols: size.cols,
        rows: size.rows,
        data: (_terminal, data) => this.onPtyData(data),
      },
    });
    this.exited = this.proc.exited;
    this.exited
      .then((exitCode) => this.onExited(exitCode))
      .catch((err: unknown) => {
        log.error(`Terminal ${this.shortId} exit handling failed`, { error: err });
      });
  }

  /** Total output bytes produced so far. */
  get outputOffset(): number {
    return this.ring.end;
  }

  get attached(): boolean {
    return this.sink !== null;
  }

  /**
   * Bind a client. With a `since` point from this epoch still covered by the resume ring, the
   * client keeps its xterm and only receives the bytes it missed; otherwise it gets a snapshot of
   * the emulator. Replaces any previously attached client. The session counts as attached from
   * this call on, even while the snapshot is still being produced.
   */
  async attach(
    sink: TerminalSink,
    since?: { epoch: string | undefined; offset: number | undefined },
  ): Promise<void> {
    const generation = ++this.attachGeneration;
    this.sink = sink;
    this.streaming = false;
    this.unacked = 0;
    this.paused = false;

    if (since?.offset !== undefined && since.epoch === this.epoch) {
      const sinceOffset = since.offset;
      const missed = this.ring.readFrom(sinceOffset);
      if (missed) {
        log.info(
          `Resuming terminal ${this.shortId} from offset ${sinceOffset} (${missed.byteLength} bytes missed)`,
        );
        sink.sendState(this.state("resume", sinceOffset));
        this.goLive(sink, sinceOffset, missed);
        return;
      }
    }

    await this.syncWithSnapshot(sink, generation);
  }

  /** Stop streaming to the attached client. The shell keeps running. */
  detach(): void {
    if (!this.sink) return;
    log.debug(`Detaching terminal ${this.shortId}`);
    this.attachGeneration++;
    this.sink = null;
    this.streaming = false;
  }

  /** Keyboard input or terminal replies from the client, written to the PTY verbatim. */
  write(data: Uint8Array): void {
    this.proc.terminal?.write(data);
  }

  resize(requestedCols: number, requestedRows: number): void {
    const { cols, rows } = clampTerminalSize(requestedCols, requestedRows);
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.proc.terminal?.resize(cols, rows);
    this.emulator.resize(cols, rows);
  }

  setScrollbackLines(lines: number | undefined): void {
    const clamped = clampScrollbackLines(lines);
    if (this.emulator.options.scrollback !== clamped) this.emulator.options.scrollback = clamped;
  }

  /** Flow control: the client has parsed `bytes` more bytes under the sync at `syncOffset`. */
  ack(syncOffset: number, bytes: number): void {
    if (syncOffset !== this.syncOffset) return;
    this.unacked = Math.max(0, this.unacked - bytes);
    if (!this.paused || this.unacked > this.lowWater || !this.sink) return;
    log.info(`Terminal ${this.shortId} client caught up, resyncing with a snapshot`);
    void this.attach(this.sink);
  }

  destroy(): void {
    if (this.disposed) return;
    log.debug(`Destroying terminal ${this.shortId}`);
    this.disposed = true;
    this.attachGeneration++;
    this.sink = null;
    // Snapshots in flight would otherwise await write callbacks that never fire.
    for (const resolve of this.pendingSerializes) resolve("");
    this.pendingSerializes.clear();
    this.emulator.dispose();
    try {
      this.proc.terminal?.close();
      this.proc.kill();
    } catch {
      // Process may already be dead
    }
  }

  private get shortId(): string {
    return this.id.slice(0, 8);
  }

  private state(mode: TerminalState["mode"], offset: number, snapshot?: string): TerminalState {
    const base = { id: this.id, epoch: this.epoch, mode, offset, cols: this.cols, rows: this.rows };
    return snapshot === undefined ? base : { ...base, snapshot };
  }

  private onPtyData(data: Uint8Array): void {
    // The PTY can deliver a final chunk after destroy(); the emulator is gone by then.
    if (this.disposed) return;
    // Copy: Bun may reuse the read buffer after the callback returns.
    const chunk = new Uint8Array(data);
    const offset = this.ring.end;
    this.ring.push(chunk);
    this.feedEmulator(chunk);
    stress.track("pty-output");

    if (!this.sink || !this.streaming || this.paused) return;
    this.forward(this.sink, offset, chunk);
  }

  /** Send output to the client and account for it against the flow-control budget. */
  private forward(sink: TerminalSink, offset: number, data: Uint8Array): void {
    sink.sendOutput(offset, data);
    this.unacked += data.byteLength;
    if (this.unacked > this.highWater && !this.paused) {
      this.paused = true;
      log.info(`Terminal ${this.shortId} client is ${this.unacked} bytes behind, pausing output`);
    }
  }

  private feedEmulator(chunk: Uint8Array): void {
    try {
      this.emulator.write(chunk);
    } catch (err) {
      // xterm throws once its write queue passes its discard watermark (tens of MB unparsed).
      // The screen will be stale until the next snapshot; log it once.
      this.noteEmulatorOverflow(err);
    }
  }

  private async syncWithSnapshot(sink: TerminalSink, generation: number): Promise<void> {
    // The snapshot reflects the emulator at `offset`. Pin the ring so a flood cannot evict the
    // bytes produced while serializing; they are streamed right after the snapshot.
    const offset = this.ring.end;
    const pin = this.ring.pin(offset);
    try {
      const snapshot = await this.serialize();
      if (generation !== this.attachGeneration || this.disposed) return;
      const produced = this.ring.readFrom(offset);
      if (!produced) throw new Error(`Output at offset ${offset} was evicted while pinned`);
      log.info(
        `Attaching terminal ${this.shortId} with a ${snapshot.length}-byte snapshot at offset ${offset}` +
          (produced.byteLength > 0 ? ` (+${produced.byteLength} bytes produced meanwhile)` : ""),
      );
      sink.sendState(this.state("snapshot", offset, snapshot));
      this.goLive(sink, offset, produced);
    } finally {
      this.ring.unpin(pin);
    }
  }

  private goLive(sink: TerminalSink, offset: number, pending: Uint8Array): void {
    this.syncOffset = offset;
    if (pending.byteLength > 0) this.forward(sink, offset, pending);
    this.streaming = true;
  }

  /** Serialize the emulator once everything written so far has been parsed. */
  private serialize(): Promise<string> {
    return new Promise((resolve) => {
      this.pendingSerializes.add(resolve);
      try {
        this.emulator.write("", () => {
          this.pendingSerializes.delete(resolve);
          // destroy() already resolved this promise; the disposed emulator must not be read.
          if (this.disposed) return;
          resolve(this.serializer.serialize());
        });
      } catch (err) {
        // The write queue is past xterm's discard watermark (see feedEmulator). Serve the stale
        // screen rather than leave the attach hanging with the session mute.
        this.pendingSerializes.delete(resolve);
        this.noteEmulatorOverflow(err);
        resolve(this.serializer.serialize());
      }
    });
  }

  private noteEmulatorOverflow(err: unknown): void {
    if (this.emulatorOverflowed) return;
    this.emulatorOverflowed = true;
    log.warn(`Terminal ${this.shortId} emulator overflowed, dropping output from the screen`, {
      error: err,
    });
  }

  private registerNotificationHandlers(): void {
    const { emulator, options } = this;
    const emit = (payload: OscPayload | null) => {
      if (payload) options.onNotification(this, payload);
    };
    emulator.parser.registerOscHandler(9, (data) => {
      if (options.isSequenceEnabled("osc9")) emit(parseOsc9(data));
      return false;
    });
    emulator.parser.registerOscHandler(777, (data) => {
      if (options.isSequenceEnabled("osc777")) emit(parseOsc777(data));
      return false;
    });
    emulator.parser.registerOscHandler(99, (data) => {
      if (options.isSequenceEnabled("osc99")) emit(parseOsc99(data));
      return false;
    });
  }

  private async onExited(exitCode: number): Promise<void> {
    log.info(`Terminal ${this.shortId} exited with code ${exitCode}`);
    // A paused client is still behind; without this final snapshot the tail of the output would
    // be lost, since the manager destroys the session (ring and emulator) right after onExit.
    if (this.sink && this.paused) await this.attach(this.sink);
    this.sink?.sendExit(exitCode);
    this.options.onExit(this, exitCode);
  }
}
