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
afterEach(() => {
  for (const session of sessions.splice(0)) session.destroy();
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
const QUERY_SCRIPT = String.raw`printf 'hello \033]11;?\033\\ \033[6n \033]9;done\007 world\n'; sleep 30`;

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
    const { session } = spawnScript(`sleep 0.2; printf 'later\\n'; sleep 30`);
    const client = createRecordingSink();
    await session.attach(client.sink);
    const snapshotOffset = client.states[0]!.offset;

    await until(() => client.outputText().includes("later"));
    expect(client.output[0]!.offset).toBe(snapshotOffset);
    expect(session.outputOffset).toBe(snapshotOffset + client.outputBytes());
  });

  test("resume attach streams only the bytes the client missed", async () => {
    const { session } = spawnScript(`printf 'first\\n'; sleep 0.3; printf 'second\\n'; sleep 30`);
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

  test("resume falls back to a snapshot once the ring has evicted the offset", async () => {
    const { session } = spawnScript(
      String.raw`printf 'hello\n'; sleep 0.2; printf 'more\n'; sleep 30`,
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
    const { session } = spawnScript("sleep 30");
    expect(session.attached).toBe(false);
    const attach = session.attach(createRecordingSink().sink);
    expect(session.attached).toBe(true);
    await attach;
    session.detach();
    expect(session.attached).toBe(false);
  });

  test("resize applies to the PTY and the emulator", async () => {
    const { session } = spawnScript(`stty size; sleep 0.3; stty size; sleep 30`);
    const client = createRecordingSink();
    await session.attach(client.sink);
    session.resize(100, 30);
    await until(() => client.outputText().includes("30 100"));
    expect(session.cols).toBe(100);
    expect(session.rows).toBe(30);
  });

  test("pauses a client that stops acking and resyncs with a snapshot once it catches up", async () => {
    const { session } = spawnScript(
      `i=0; while [ $i -lt 400 ]; do printf 'line %04d of output padding padding padding padding padding\\n' $i; i=$((i+1)); done; sleep 30`,
      { flowControl: { highWaterBytes: 4096, lowWaterBytes: 1024 } },
    );
    const client = createRecordingSink();
    await session.attach(client.sink);
    await until(() => session.outputOffset > 20_000);
    await Bun.sleep(50);

    // Streaming stopped at the high-water mark; the emulator kept parsing.
    const streamed = client.outputBytes();
    expect(streamed).toBeLessThan(session.outputOffset);
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

  test("destroy settles an attach whose snapshot is still pending", async () => {
    const { session } = spawnScript("sleep 30");
    const client = createRecordingSink();
    const attach = session.attach(client.sink);
    session.destroy();
    await attach;
    expect(client.states).toHaveLength(0);
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
