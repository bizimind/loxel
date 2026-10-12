import { afterEach, describe, expect, test } from "bun:test";

import type { TerminalState } from "@/api/ws-protocol";
import type { OscPayload } from "@/lib/osc-notification-parser";

import type { TerminalSessionOptions, TerminalSink } from "./terminal-session";
import { OutputRing, TerminalSession } from "./terminal-session";

const textDecoder = new TextDecoder();

/** Sink that records everything a session sends it. */
function createRecordingSink() {
  const states: TerminalState[] = [];
  const output: { offset: number; data: Uint8Array }[] = [];
  const exits: number[] = [];
  const sink: TerminalSink = {
    sendState: (state) => states.push(state),
    sendOutput: (offset, data) => output.push({ offset, data }),
    sendExit: (code) => exits.push(code),
  };
  const outputText = () => output.map((o) => textDecoder.decode(o.data)).join("");
  const outputBytes = () => output.reduce((n, o) => n + o.data.byteLength, 0);
  return { sink, states, output, exits, outputText, outputBytes };
}

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await Bun.sleep(10);
  }
}

const sessions: TerminalSession[] = [];
afterEach(async () => {
  // Destroy and wait for the shells to be gone so nothing from this file outlives it.
  const pending = sessions.splice(0);
  for (const session of pending) session.destroy();
  await Promise.race([Promise.all(pending.map((s) => s.exited)), Bun.sleep(2000)]);
});

/** Spawn a session running a shell script, with notification callbacks recorded. */
function spawnScript(
  script: string,
  overrides: Partial<TerminalSessionOptions> = {},
): { session: TerminalSession; notifications: OscPayload[]; exits: number[] } {
  const notifications: OscPayload[] = [];
  const exits: number[] = [];
  const session = new TerminalSession({
    id: crypto.randomUUID(),
    cols: 80,
    rows: 24,
    cwd: "/tmp",
    env: { ...process.env, TERM: "xterm-256color" },
    command: ["/bin/sh", "-c", script],
    isSequenceEnabled: () => true,
    onNotification: (_session, payload) => notifications.push(payload),
    onExit: (_session, code) => exits.push(code),
    ...overrides,
  });
  sessions.push(session);
  return { session, notifications, exits };
}

/** Prints a line with terminal queries and a notification, then idles so the session stays alive. */
const QUERY_SCRIPT = String.raw`printf 'hello \033]11;?\033\\ \033[6n \033]9;done\007 world\n'; exec sleep 30`;

describe("OutputRing", () => {
  test("reads from any retained offset and reports evicted ranges", () => {
    const ring = new OutputRing(10);
    ring.push(new Uint8Array([1, 2, 3, 4]));
    ring.push(new Uint8Array([5, 6, 7]));
    expect(ring.start).toBe(0);
    expect(ring.end).toBe(7);
    expect([...ring.readFrom(0)!]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect([...ring.readFrom(2)!]).toEqual([3, 4, 5, 6, 7]);
    expect([...ring.readFrom(7)!]).toEqual([]);
    expect(ring.readFrom(8)).toBeNull();

    ring.push(new Uint8Array([8, 9, 10, 11, 12]));
    expect(ring.start).toBe(4);
    expect(ring.readFrom(3)).toBeNull();
    expect([...ring.readFrom(4)!]).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test("a pin keeps everything from the pinned offset on, beyond capacity", () => {
    const ring = new OutputRing(4);
    ring.push(new Uint8Array([1, 2]));
    const pin = ring.pin(2);
    ring.push(new Uint8Array([3, 4]));
    ring.push(new Uint8Array([5, 6]));
    ring.push(new Uint8Array([7, 8]));
    // The chunk before the pin was evicted; everything after it survived.
    expect(ring.start).toBe(2);
    expect([...ring.readFrom(2)!]).toEqual([3, 4, 5, 6, 7, 8]);
    expect(ring.readFrom(1)).toBeNull();

    ring.unpin(pin);
    ring.push(new Uint8Array([9]));
    expect(ring.start).toBe(6);
    expect(ring.readFrom(2)).toBeNull();
    expect([...ring.readFrom(6)!]).toEqual([7, 8, 9]);
  });

  test("overlapping pins are independent; the oldest one wins", () => {
    const ring = new OutputRing(2);
    ring.push(new Uint8Array([1, 2]));
    const older = ring.pin(2);
    ring.push(new Uint8Array([3, 4]));
    const newer = ring.pin(4);
    ring.push(new Uint8Array([5, 6]));
    expect(ring.start).toBe(2);

    // Releasing the older pin must not release the newer one.
    ring.unpin(older);
    ring.push(new Uint8Array([7, 8]));
    expect(ring.start).toBe(4);
    expect([...ring.readFrom(4)!]).toEqual([5, 6, 7, 8]);

    ring.unpin(newer);
    ring.push(new Uint8Array([9]));
    expect(ring.start).toBe(8);
  });

  test("always keeps the newest chunk even when it exceeds capacity", () => {
    const ring = new OutputRing(2);
    ring.push(new Uint8Array([1, 2, 3, 4, 5]));
    expect(ring.start).toBe(0);
    expect([...ring.readFrom(0)!]).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("TerminalSession", () => {
  test("snapshot attach carries the screen but not the terminal queries in old output", async () => {
    const { session, notifications } = spawnScript(QUERY_SCRIPT);
    await until(() => session.outputOffset > 0);
    await until(() => notifications.length === 1);

    const client = createRecordingSink();
    await session.attach(client.sink);

    expect(client.states).toHaveLength(1);
    const state = client.states[0]!;
    expect(state.mode).toBe("snapshot");
    expect(state.cols).toBe(80);
    expect(state.snapshot).toContain("hello");
    expect(state.snapshot).toContain("world");
    expect(state.snapshot).not.toContain("\x1b]11;?");
    expect(state.snapshot).not.toContain("\x1b[6n");
    expect(state.snapshot).not.toContain("\x1b]9;");
    // Everything produced before the snapshot is covered by it, nothing is streamed twice.
    expect(client.outputBytes()).toBe(0);
    expect(state.offset).toBe(session.outputOffset);
  });

  test("notifications fire once on the server, regardless of attaches", async () => {
    const { session, notifications } = spawnScript(QUERY_SCRIPT);
    await until(() => notifications.length === 1);
    expect(notifications[0]).toEqual({ body: "done", urgency: "normal" });

    await session.attach(createRecordingSink().sink);
    session.detach();
    await session.attach(createRecordingSink().sink);
    await Bun.sleep(50);
    expect(notifications).toHaveLength(1);
  });

  test("disabled sequences are ignored", async () => {
    const { notifications, session } = spawnScript(QUERY_SCRIPT, {
      isSequenceEnabled: (sequence) => sequence !== "osc9",
    });
    await until(() => session.outputOffset > 0);
    await Bun.sleep(50);
    expect(notifications).toHaveLength(0);
  });

  test("live output streams with stream offsets after attach", async () => {
    const { session } = spawnScript(`sleep 0.2; printf 'later\\n'; exec sleep 30`);
    const client = createRecordingSink();
    await session.attach(client.sink);
    const snapshotOffset = client.states[0]!.offset;

    await until(() => client.outputText().includes("later"));
    expect(client.output[0]!.offset).toBe(snapshotOffset);
    expect(session.outputOffset).toBe(snapshotOffset + client.outputBytes());
  });

  test("resume attach streams only the bytes the client missed", async () => {
    const { session } = spawnScript(
      `printf 'first\\n'; sleep 0.3; printf 'second\\n'; exec sleep 30`,
    );
    const first = createRecordingSink();
    await session.attach(first.sink);
    await until(
      () => first.outputText().includes("first") || first.states[0]!.snapshot!.includes("first"),
    );
    const seen = first.states[0]!.offset + first.outputBytes();
    session.detach();

    await until(() => session.outputOffset > seen);
    const second = createRecordingSink();
    await session.attach(second.sink, { epoch: session.epoch, offset: seen });

    expect(second.states[0]).toMatchObject({ mode: "resume", offset: seen });
    expect(second.states[0]!.snapshot).toBeUndefined();
    expect(second.output[0]!.offset).toBe(seen);
    expect(second.outputText()).toContain("second");
    expect(second.outputText()).not.toContain("first");
  });

  test("a flood during the snapshot is streamed after it, not lost", async () => {
    // A 64-byte ring would normally evict everything produced while serializing; the pin keeps it.
    const line = "line %04d of output padding padding padding padding padding\\n";
    const { session } = spawnScript(
      `sleep 0.2; i=0; while [ $i -lt 300 ]; do printf '${line}' $i; i=$((i+1)); done; exec sleep 30`,
      { resumeRingBytes: 64 },
    );
    const client = createRecordingSink();
    await session.attach(client.sink);
    await until(() => client.outputText().includes("line 0299"));

    const state = client.states[0]!;
    expect(client.output[0]!.offset).toBe(state.offset);
    // Frames are contiguous from the snapshot offset to the end of the stream: no hole.
    let expected = state.offset;
    for (const frame of client.output) {
      expect(frame.offset).toBe(expected);
      expected += frame.data.byteLength;
    }
    expect(expected).toBe(session.outputOffset);
    expect(client.outputText()).toContain("line 0000");
  });

  test("a second attach during a snapshot supersedes the first and keeps the stream intact", async () => {
    const line = "line %04d of output padding padding padding padding padding\\n";
    const { session } = spawnScript(
      `sleep 0.2; i=0; while [ $i -lt 300 ]; do printf '${line}' $i; i=$((i+1)); done; exec sleep 30`,
      { resumeRingBytes: 64 },
    );
    const first = createRecordingSink();
    const second = createRecordingSink();
    const attach1 = session.attach(first.sink);
    const attach2 = session.attach(second.sink);
    await Promise.all([attach1, attach2]);
    await until(() => second.outputText().includes("line 0299"));

    expect(first.states).toHaveLength(0);
    expect(first.output).toHaveLength(0);
    const state = second.states[0]!;
    expect(state.mode).toBe("snapshot");
    let expected = state.offset;
    for (const frame of second.output) {
      expect(frame.offset).toBe(expected);
      expected += frame.data.byteLength;
    }
    expect(expected).toBe(session.outputOffset);
  });

  test("resume falls back to a snapshot once the ring has evicted the offset", async () => {
    const { session } = spawnScript(
      String.raw`printf 'hello\n'; sleep 0.2; printf 'more\n'; exec sleep 30`,
      { resumeRingBytes: 8 },
    );
    await until(() => session.outputOffset > 0);
    const firstChunk = session.outputOffset;
    await until(() => session.outputOffset > firstChunk);

    const client = createRecordingSink();
    await session.attach(client.sink, { epoch: session.epoch, offset: 0 });
    expect(client.states[0]!.mode).toBe("snapshot");
    expect(client.states[0]!.snapshot).toContain("hello");
  });

  test("an offset from another spawn never resumes, even if it is in range", async () => {
    const { session: previous } = spawnScript(QUERY_SCRIPT);
    const { session } = spawnScript(QUERY_SCRIPT);
    await until(() => previous.outputOffset > 0 && session.outputOffset > 0);
    expect(session.epoch).not.toBe(previous.epoch);

    const client = createRecordingSink();
    await session.attach(client.sink, { epoch: previous.epoch, offset: 0 });
    expect(client.states[0]!.mode).toBe("snapshot");
    expect(client.states[0]!.epoch).toBe(session.epoch);
  });

  test("a detached session is reported as not attached", async () => {
    const { session } = spawnScript("exec sleep 30");
    expect(session.attached).toBe(false);
    const attach = session.attach(createRecordingSink().sink);
    expect(session.attached).toBe(true);
    await attach;
    session.detach();
    expect(session.attached).toBe(false);
  });

  test("sizes from the client are clamped before they reach the PTY and the emulator", async () => {
    const { session } = spawnScript(`stty size; sleep 0.3; stty size; exec sleep 30`, {
      cols: 50_000,
      rows: Infinity,
    });
    expect(session.cols).toBe(1_000);
    expect(session.rows).toBe(24);
    const client = createRecordingSink();
    await session.attach(client.sink);
    session.resize(0.5, 9_999);
    await until(() => client.outputText().includes("500 2"));
    expect(session.cols).toBe(2);
    expect(session.rows).toBe(500);
  });

  test("resize applies to the PTY and the emulator", async () => {
    const { session } = spawnScript(`stty size; sleep 0.3; stty size; exec sleep 30`);
    const client = createRecordingSink();
    await session.attach(client.sink);
    session.resize(100, 30);
    await until(() => client.outputText().includes("30 100"));
    expect(session.cols).toBe(100);
    expect(session.rows).toBe(30);
  });

  test("pauses a client that stops acking and resyncs with a snapshot once it catches up", async () => {
    // Two bursts: the first crosses the high-water mark (a PTY may deliver it as one chunk, which
    // is still forwarded whole); the second arrives while paused and must not be streamed.
    const line = "line %04d of output padding padding padding padding padding\\n";
    const burst = (from: number, to: number) =>
      `i=${from}; while [ $i -lt ${to} ]; do printf '${line}' $i; i=$((i+1)); done`;
    const { session } = spawnScript(
      `${burst(0, 100)}; sleep 0.3; ${burst(100, 400)}; exec sleep 30`,
      { flowControl: { highWaterBytes: 4096, lowWaterBytes: 1024 } },
    );
    const client = createRecordingSink();
    await session.attach(client.sink);
    await until(() => session.outputOffset > 20_000);
    await Bun.sleep(50);

    // Streaming stopped at the high-water mark during the first burst; the emulator kept parsing.
    const streamed = client.outputBytes();
    expect(streamed).toBeGreaterThan(4096);
    expect(streamed).toBeLessThan(10_000);
    expect(client.states).toHaveLength(1);

    // Acks from an earlier sync are ignored.
    session.ack(client.states[0]!.offset + 1, streamed);
    await Bun.sleep(50);
    expect(client.states).toHaveLength(1);

    session.ack(client.states[0]!.offset, streamed);
    await until(() => client.states.length === 2);
    expect(client.states[1]!.mode).toBe("snapshot");
    expect(client.states[1]!.snapshot).toContain("line 0399");
    expect(client.states[1]!.offset).toBe(session.outputOffset);
  });

  test("destroy settles every attach whose snapshot is still pending", async () => {
    const { session } = spawnScript("exec sleep 30");
    const first = createRecordingSink();
    const second = createRecordingSink();
    const attach1 = session.attach(first.sink);
    const attach2 = session.attach(second.sink);
    session.destroy();
    await Promise.all([attach1, attach2]);
    expect(first.states).toHaveLength(0);
    expect(second.states).toHaveLength(0);
  });

  test("a shell exiting while the client is paused gets a final snapshot before the exit", async () => {
    const line = "line %04d of output padding padding padding padding padding\\n";
    const { session, exits } = spawnScript(
      `i=0; while [ $i -lt 400 ]; do printf '${line}' $i; i=$((i+1)); done; exit 0`,
      { flowControl: { highWaterBytes: 4096, lowWaterBytes: 1024 } },
    );
    const client = createRecordingSink();
    await session.attach(client.sink);
    await until(() => exits.length === 1);

    expect(client.exits).toEqual([0]);
    const last = client.states.at(-1)!;
    expect(last.mode).toBe("snapshot");
    expect(last.snapshot).toContain("line 0399");
    expect(last.offset).toBe(session.outputOffset);
  });

  test("exit reaches the attached client and the owner callback", async () => {
    const { session, exits } = spawnScript("exit 3");
    const client = createRecordingSink();
    await session.attach(client.sink);
    await until(() => exits.length === 1);
    expect(exits).toEqual([3]);
    expect(client.exits).toEqual([3]);
  });
});
