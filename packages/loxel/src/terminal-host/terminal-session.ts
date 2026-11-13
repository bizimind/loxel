/**
 * One terminal session: a PTY-backed program plus a headless xterm that is the source of truth for
 * the screen, scrollback, size and modes. A client attaches to receive either a snapshot of that
 * emulator or, if its own xterm is still current, the output it missed, and then the live stream.
 * Raw history is never replayed into a fresh xterm, so terminal queries, bells and notifications in
 * old output never fire a second time. See docs/TERMINALS.md and docs/TERMINAL_HOST.md.
 */
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { Subprocess } from "bun";

import type { ChildLogger } from "@/api/log-entry-model";
import { clampScrollbackLines, clampTerminalSize } from "@/api/terminal-limits";
import type { TerminalState } from "@/api/terminal-stream";
import { BIN_OUTPUT_HEADER_SIZE, encodeOutputFrame } from "@/api/terminal-stream";

import type { TerminalHostEvent } from "./terminal-host";
import { OSC_NOTIFICATION_CODES } from "./terminal-host";

/** Bytes of recent output kept so a reconnecting client can resume without a snapshot. */
export const RESUME_RING_BYTES = 1024 * 1024;
/** Unacknowledged bytes above which output streaming to the client pauses. */
export const FLOW_HIGH_WATER_BYTES = 2 * 1024 * 1024;
/** Unacknowledged bytes below which a paused client is brought back with a snapshot. */
export const FLOW_LOW_WATER_BYTES = 128 * 1024;

/** The events a session sends on its own; its exit goes to `onExit`, for the host to announce. */
export type TerminalSessionEvent = Exclude<TerminalHostEvent, { type: "exit" | "ended" | "lost" }>;

/** What the process running the sessions provides them. */
export interface TerminalSessionRuntime {
  log: ChildLogger;
  /** Overrides for tests. */
  resumeRingBytes?: number;
  flowControl?: { highWaterBytes: number; lowWaterBytes: number };
}

export interface TerminalSessionOptions {
  id: string;
  epoch: string;
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  cols: number;
  rows: number;
  scrollbackLines: number;
  runtime: TerminalSessionRuntime;
  emit: (event: TerminalSessionEvent) => void;
  /** The program ended on its own, after any final resync of a paused client. */
  onExit: (exitCode: number) => void;
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
  readonly epoch: string;
  cols: number;
  rows: number;
  /** Resolves with the program's exit code once the process is gone. */
  readonly exited: Promise<number>;

  private readonly proc: Subprocess;
  private readonly emulator: HeadlessTerminal;
  private readonly serializer: SerializeAddon;
  private readonly ring: OutputRing;
  private readonly highWater: number;
  private readonly lowWater: number;
  private readonly log: ChildLogger;

  /** The attached client's attachment, set as soon as `attach()` is called. */
  private attachment: number | null = null;
  /** True once the client has been synced and receives live output. */
  private streaming = false;
  /** Offset of the state message the current sync started from; acks must quote it. */
  private syncOffset = 0;
  /** Resolvers of snapshots still waiting on the emulator; settled with "" on destroy. */
  private pendingSerializes = new Set<(snapshot: string) => void>();
  /** Invalidates in-flight snapshots when the client changes. */
  private attachGeneration = 0;
  private unacked = 0;
  private paused = false;
  /** The snapshot sync in flight, if any: the exit waits for it, so it reaches the client last. */
  private snapshotSync: Promise<void> | null = null;
  private disposed = false;
  private emulatorOverflowed = false;

  constructor(private readonly options: TerminalSessionOptions) {
    const { runtime } = options;
    this.id = options.id;
    this.epoch = options.epoch;
    this.log = runtime.log;
    const size = clampTerminalSize(options.cols, options.rows);
    this.cols = size.cols;
    this.rows = size.rows;
    this.ring = new OutputRing(runtime.resumeRingBytes ?? RESUME_RING_BYTES);
    this.highWater = runtime.flowControl?.highWaterBytes ?? FLOW_HIGH_WATER_BYTES;
    this.lowWater = runtime.flowControl?.lowWaterBytes ?? FLOW_LOW_WATER_BYTES;

    this.emulator = new HeadlessTerminal({
      cols: size.cols,
      rows: size.rows,
      scrollback: clampScrollbackLines(options.scrollbackLines),
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.emulator.loadAddon(this.serializer);
    this.registerOscHandlers();

    try {
      this.proc = Bun.spawn([...options.argv], {
        cwd: options.cwd,
        env: options.env,
        terminal: {
          cols: size.cols,
          rows: size.rows,
          data: (_terminal, data) => this.onPtyData(data),
        },
      });
    } catch (err) {
      this.emulator.dispose();
      throw err;
    }
    this.exited = this.proc.exited;
    this.exited
      .then((exitCode) => this.onExited(exitCode))
      .catch((err: unknown) => {
        this.log.error(`Terminal ${this.shortId} exit handling failed`, { error: err });
      });
  }

  get pid(): number {
    return this.proc.pid;
  }

  /** Total output bytes produced so far. */
  get outputOffset(): number {
    return this.ring.end;
  }

  get attached(): boolean {
    return this.attachment !== null;
  }

  /** Bytes of output the resume ring holds. */
  get retainedBytes(): number {
    return this.ring.end - this.ring.start;
  }

  /**
   * Bind a client under `attachment`. With a `since` point from this epoch still covered by the
   * resume ring, the client keeps its xterm and only receives the bytes it missed; otherwise it gets
   * a snapshot of the emulator. Replaces any previously attached client. The session counts as
   * attached from this call on, even while the snapshot is still being produced. Resolves to
   * whether this attach is still the session's current one: not superseded by another attach (one
   * re-sent with the same attachment number included), a detach or a destroy.
   */
  async attach(attachment: number, since?: { epoch: string; offset: number }): Promise<boolean> {
    const generation = ++this.attachGeneration;
    this.attachment = attachment;
    this.streaming = false;
    this.unacked = 0;
    this.paused = false;

    if (since && since.epoch === this.epoch) {
      const missed = this.ring.readFrom(since.offset);
      if (missed) {
        this.log.info(
          `Resuming terminal ${this.shortId} from offset ${since.offset} (${missed.byteLength} bytes missed)`,
        );
        this.sendState(attachment, this.state("resume", since.offset));
        this.goLive(since.offset, missed);
        return true;
      }
    }

    const sync = this.syncWithSnapshot(attachment, generation).finally(() => {
      if (this.snapshotSync === sync) this.snapshotSync = null;
    });
    this.snapshotSync = sync;
    await sync;
    return generation === this.attachGeneration && !this.disposed;
  }

  /** Stop streaming to the attached client. The program keeps running. */
  detach(): void {
    if (this.attachment === null) return;
    this.log.debug(`Detaching terminal ${this.shortId}`);
    this.attachGeneration++;
    this.attachment = null;
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

  setScrollbackLines(lines: number): void {
    const clamped = clampScrollbackLines(lines);
    if (this.emulator.options.scrollback !== clamped) this.emulator.options.scrollback = clamped;
  }

  /** Flow control: the client has parsed `bytes` more bytes under the sync at `syncOffset`. */
  ack(syncOffset: number, bytes: number): void {
    if (syncOffset !== this.syncOffset) return;
    this.unacked = Math.max(0, this.unacked - bytes);
    if (!this.paused || this.unacked > this.lowWater || this.attachment === null) return;
    this.log.info(`Terminal ${this.shortId} client caught up, resyncing with a snapshot`);
    void this.attach(this.attachment);
  }

  destroy(): void {
    if (this.disposed) return;
    this.log.debug(`Destroying terminal ${this.shortId}`);
    this.disposed = true;
    this.attachGeneration++;
    this.attachment = null;
    // Snapshots in flight would otherwise await write callbacks that never fire.
    for (const resolve of this.pendingSerializes) resolve("");
    this.pendingSerializes.clear();
    this.emulator.dispose();
    this.hangUp();
  }

  /**
   * Close the PTY and kill the program, keeping the screen and the ring: a session whose program
   * ended can still be attached to, to show what it printed last.
   */
  hangUp(): void {
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

  private sendState(attachment: number, state: TerminalState): void {
    this.options.emit({ type: "state", attachment, state });
  }

  private onPtyData(data: Uint8Array): void {
    // The PTY can deliver a final chunk after destroy(); the emulator is gone by then.
    if (this.disposed) return;
    // Copy: Bun may reuse the read buffer after the callback returns.
    const chunk = new Uint8Array(data);
    const offset = this.ring.end;
    this.ring.push(chunk);
    this.feedEmulator(chunk);

    if (this.attachment === null || !this.streaming || this.paused) return;
    this.forward(offset, chunk);
  }

  /** Send output to the client and account for it against the flow-control budget. */
  private forward(offset: number, data: Uint8Array): void {
    // Encoded once here: the frame goes to the renderer as is, and `data` is a view of it.
    const frame = encodeOutputFrame(this.id, offset, data);
    const payload = frame.subarray(BIN_OUTPUT_HEADER_SIZE);
    this.options.emit({ type: "output", id: this.id, offset, data: payload, frame });
    this.unacked += data.byteLength;
    if (this.unacked > this.highWater && !this.paused) {
      this.paused = true;
      this.log.info(
        `Terminal ${this.shortId} client is ${this.unacked} bytes behind, pausing output`,
      );
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

  private async syncWithSnapshot(attachment: number, generation: number): Promise<void> {
    // The snapshot reflects the emulator at `offset`. Pin the ring so a flood cannot evict the
    // bytes produced while serializing; they are streamed right after the snapshot.
    const offset = this.ring.end;
    const pin = this.ring.pin(offset);
    try {
      const snapshot = await this.serialize();
      if (generation !== this.attachGeneration || this.disposed) return;
      const produced = this.ring.readFrom(offset);
      if (!produced) throw new Error(`Output at offset ${offset} was evicted while pinned`);
      this.log.info(
        `Attaching terminal ${this.shortId} with a ${snapshot.length}-byte snapshot at offset ${offset}` +
          (produced.byteLength > 0 ? ` (+${produced.byteLength} bytes produced meanwhile)` : ""),
      );
      this.sendState(attachment, this.state("snapshot", offset, snapshot));
      this.goLive(offset, produced);
    } finally {
      this.ring.unpin(pin);
    }
  }

  private goLive(offset: number, pending: Uint8Array): void {
    this.syncOffset = offset;
    if (pending.byteLength > 0) this.forward(offset, pending);
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
    this.log.warn(`Terminal ${this.shortId} emulator overflowed, dropping output from the screen`, {
      error: err,
    });
  }

  /**
   * Report every notification sequence the emulator parses, raw: the emulator is a real parser,
   * so a sequence split across chunks is seen once, whether or not a client is attached.
   */
  private registerOscHandlers(): void {
    for (const code of OSC_NOTIFICATION_CODES) {
      this.emulator.parser.registerOscHandler(code, (data) => {
        this.options.emit({ type: "osc", id: this.id, epoch: this.epoch, code, data });
        return false;
      });
    }
  }

  private async onExited(exitCode: number): Promise<void> {
    this.log.info(`Terminal ${this.shortId} exited with code ${exitCode}`);
    // A program that exits while a snapshot is being produced (a short command, or a resync) would
    // otherwise get its exit to the client before that snapshot and the output after it.
    while (this.snapshotSync) await this.snapshotSync.catch(() => {});
    // A paused client is still behind; without this final snapshot the tail of the output would
    // be lost, since the host may destroy the session (ring and emulator) right after onExit.
    if (this.attachment !== null && this.paused) await this.attach(this.attachment);
    this.options.onExit(exitCode);
  }
}
