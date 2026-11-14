import { afterEach, describe, expect, test } from "bun:test";

import { createNoopLogger } from "@bizimind/logger";

import type { TerminalState } from "@/api/terminal-stream";
import { until } from "@/test/until";

import type { OscNotificationCode } from "./terminal-host";
import type {
  TerminalSessionEvent,
  TerminalSessionOptions,
  TerminalSessionRuntime,
} from "./terminal-session";
import { OutputRing, TerminalSession } from "./terminal-session";

const textDecoder = new TextDecoder();

/**
 * Records everything a session emits. Output is credited to the attachment whose state preceded
 * it, which is how the host's caller tells clients apart.
 */
function createRecorder() {
  const states: { attachment: number; state: TerminalState }[] = [];
  const output: { attachment: number | null; offset: number; data: Uint8Array }[] = [];
  const osc: { code: OscNotificationCode; data: string }[] = [];
  let live: number | null = null;
  const emit = (event: TerminalSessionEvent) => {
    switch (event.type) {
      case "state":
        live = event.attachment;
        states.push({ attachment: event.attachment, state: event.state });
        return;
      case "output":
        output.push({ attachment: live, offset: event.offset, data: event.data });
        return;
      case "osc":
        osc.push({ code: event.code, data: event.data });
        return;
      default: {
        const unknownEvent: never = event;
        throw new Error(`Unexpected event ${JSON.stringify(unknownEvent)}`);
      }
    }
  };
  /** What the client of `attachment` received. */
  const client = (attachment: number) => {
    const frames = output.filter((o) => o.attachment === attachment);
    return {
      states: states.filter((s) => s.attachment === attachment).map((s) => s.state),
      output: frames,
      outputText: () => frames.map((o) => textDecoder.decode(o.data)).join(""),
      outputBytes: () => frames.reduce((n, o) => n + o.data.byteLength, 0),
    };
  };
  return { emit, states, osc, client };
}

const sessions: TerminalSession[] = [];
afterEach(async () => {
  // Destroy and wait for the shells to be gone so nothing from this file outlives it.
  const pending = sessions.splice(0);
  for (const session of pending) session.destroy();
  await Promise.race([Promise.all(pending.map((s) => s.exited)), Bun.sleep(2000)]);
});

/** Spawn a session running a shell script, with everything it emits recorded. */
function spawnScript(
  script: string,
  overrides: Partial<Pick<TerminalSessionOptions, "cols" | "rows">> & {
    runtime?: Partial<TerminalSessionRuntime>;
  } = {},
) {
  const recorder = createRecorder();
  const exits: number[] = [];
  const session = new TerminalSession({
    id: crypto.randomUUID(),
    epoch: crypto.randomUUID(),
    argv: ["/bin/sh", "-c", script],
    cwd: "/tmp",
    env: { ...definedProcessEnv(), TERM: "xterm-256color" },
    cols: overrides.cols ?? 80,
    rows: overrides.rows ?? 24,
    scrollbackLines: 1_000,
    runtime: { log: createNoopLogger(), ...overrides.runtime },
    emit: recorder.emit,
    onExit: (code) => exits.push(code),
  });
  sessions.push(session);
  return { session, recorder, exits };
}

function definedProcessEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
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
    const { session, recorder } = spawnScript(QUERY_SCRIPT);
    await until(() => session.outputOffset > 0);
    await until(() => recorder.osc.length === 1);

    await session.attach(1);
    const client = recorder.client(1);

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

  test("notifications are reported once, regardless of attaches", async () => {
    const { session, recorder } = spawnScript(QUERY_SCRIPT);
    await until(() => recorder.osc.length === 1);
    expect(recorder.osc[0]).toEqual({ code: 9, data: "done" });

    await session.attach(1);
    session.detach();
    // The attach resolves once the emulator has parsed everything written so far.
    await session.attach(2);
    expect(recorder.osc).toHaveLength(1);
  });

  test("every notification sequence is reported raw, including ones no parser accepts", async () => {
    const { recorder } = spawnScript(
      String.raw`printf '\033]9;a\007\033]777;notify;T;B\007\033]777;other\007\033]99;p=body;hi\033\\'; exec sleep 30`,
    );
    await until(() => recorder.osc.length === 4);
    expect(recorder.osc).toEqual([
      { code: 9, data: "a" },
      { code: 777, data: "notify;T;B" },
      { code: 777, data: "other" },
      { code: 99, data: "p=body;hi" },
    ]);
  });

  test("live output streams with stream offsets after attach", async () => {
    const { session, recorder } = spawnScript(`sleep 0.2; printf 'later\\n'; exec sleep 30`);
    await session.attach(1);
    const client = recorder.client(1);
    const snapshotOffset = client.states[0]!.offset;

    await until(() => recorder.client(1).outputText().includes("later"));
    const live = recorder.client(1);
    expect(live.output[0]!.offset).toBe(snapshotOffset);
    expect(session.outputOffset).toBe(snapshotOffset + live.outputBytes());
  });

  test("resume attach streams only the bytes the client missed", async () => {
    const { session, recorder } = spawnScript(
      `printf 'first\\n'; sleep 0.3; printf 'second\\n'; exec sleep 30`,
    );
    await session.attach(1);
    await until(
      () =>
        recorder.client(1).outputText().includes("first") ||
        recorder.client(1).states[0]!.snapshot!.includes("first"),
    );
    const first = recorder.client(1);
    const seen = first.states[0]!.offset + first.outputBytes();
    session.detach();

    await until(() => session.outputOffset > seen);
    await session.attach(2, { epoch: session.epoch, offset: seen });
    await until(() => recorder.client(2).outputText().includes("second"));

    const second = recorder.client(2);
    expect(second.states[0]).toMatchObject({ mode: "resume", offset: seen });
    expect(second.states[0]!.snapshot).toBeUndefined();
    expect(second.output[0]!.offset).toBe(seen);
    expect(second.outputText()).not.toContain("first");
  });

  test("a flood during the snapshot is streamed after it, not lost", async () => {
    // A 64-byte ring would normally evict everything produced while serializing; the pin keeps it.
    const line = "line %04d of output padding padding padding padding padding\\n";
    const { session, recorder } = spawnScript(
      `sleep 0.2; i=0; while [ $i -lt 300 ]; do printf '${line}' $i; i=$((i+1)); done; exec sleep 30`,
      { runtime: { resumeRingBytes: 64 } },
    );
    await session.attach(1);
    await until(() => recorder.client(1).outputText().includes("line 0299"));

    const client = recorder.client(1);
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
    const { session, recorder } = spawnScript(
      `sleep 0.2; i=0; while [ $i -lt 300 ]; do printf '${line}' $i; i=$((i+1)); done; exec sleep 30`,
      { runtime: { resumeRingBytes: 64 } },
    );
    const attach1 = session.attach(1);
    const attach2 = session.attach(2);
    await Promise.all([attach1, attach2]);
    await until(() => recorder.client(2).outputText().includes("line 0299"));

    expect(recorder.client(1).states).toHaveLength(0);
    // Nothing reached anyone before the second attach's state.
    expect(recorder.states).toHaveLength(1);
    const second = recorder.client(2);
    const state = second.states[0]!;
    expect(state.mode).toBe("snapshot");
    let expected = state.offset;
    for (const frame of second.output) {
      expect(frame.offset).toBe(expected);
      expected += frame.data.byteLength;
    }
    expect(expected).toBe(session.outputOffset);
  });

  test("an attach's token stays current across flow-control resyncs, and only its own", async () => {
    const { session } = spawnScript("exec sleep 30");
    const token = await session.attach(1);
    expect(session.isCurrent(token)).toBe(true);
    // Re-sent under the same number, as after a reconnect: a new attach all the same.
    const again = await session.attach(1);
    expect(session.isCurrent(token)).toBe(false);
    expect(session.isCurrent(again)).toBe(true);
    session.detach();
    expect(session.isCurrent(again)).toBe(false);
  });

  test("resume falls back to a snapshot once the ring has evicted the offset", async () => {
    const { session, recorder } = spawnScript(
      String.raw`printf 'hello\n'; sleep 0.2; printf 'more\n'; exec sleep 30`,
      { runtime: { resumeRingBytes: 8 } },
    );
    await until(() => session.outputOffset > 0);
    const firstChunk = session.outputOffset;
    await until(() => session.outputOffset > firstChunk);

    await session.attach(1, { epoch: session.epoch, offset: 0 });
    const client = recorder.client(1);
    expect(client.states[0]!.mode).toBe("snapshot");
    expect(client.states[0]!.snapshot).toContain("hello");
  });

  test("an offset from another spawn never resumes, even if it is in range", async () => {
    const { session: previous } = spawnScript(QUERY_SCRIPT);
    const { session, recorder } = spawnScript(QUERY_SCRIPT);
    await until(() => previous.outputOffset > 0 && session.outputOffset > 0);
    expect(session.epoch).not.toBe(previous.epoch);

    await session.attach(1, { epoch: previous.epoch, offset: 0 });
    const client = recorder.client(1);
    expect(client.states[0]!.mode).toBe("snapshot");
    expect(client.states[0]!.epoch).toBe(session.epoch);
  });

  test("a detached session is reported as not attached", async () => {
    const { session } = spawnScript("exec sleep 30");
    expect(session.attached).toBe(false);
    const attach = session.attach(1);
    expect(session.attached).toBe(true);
    await attach;
    session.detach();
    expect(session.attached).toBe(false);
  });

  test("sizes from the client are clamped before they reach the PTY and the emulator", async () => {
    const { session, recorder } = spawnScript(`stty size; sleep 0.3; stty size; exec sleep 30`, {
      cols: 50_000,
      rows: Infinity,
    });
    expect(session.cols).toBe(1_000);
    expect(session.rows).toBe(24);
    await session.attach(1);
    session.resize(0.5, 9_999);
    await until(() => recorder.client(1).outputText().includes("500 2"));
    expect(session.cols).toBe(2);
    expect(session.rows).toBe(500);
  });

  test("resize applies to the PTY and the emulator", async () => {
    const { session, recorder } = spawnScript(`stty size; sleep 0.3; stty size; exec sleep 30`);
    await session.attach(1);
    session.resize(100, 30);
    await until(() => recorder.client(1).outputText().includes("30 100"));
    expect(session.cols).toBe(100);
    expect(session.rows).toBe(30);
  });

  test("pauses a client that stops acking and resyncs with a snapshot once it catches up", async () => {
    // Two bursts: the first crosses the high-water mark (a PTY may deliver it as one chunk, which
    // is still forwarded whole); the second arrives while paused and must not be streamed.
    const line = "line %04d of output padding padding padding padding padding\\n";
    const burst = (from: number, to: number) =>
      `i=${from}; while [ $i -lt ${to} ]; do printf '${line}' $i; i=$((i+1)); done`;
    const { session, recorder } = spawnScript(
      `${burst(0, 100)}; sleep 0.3; ${burst(100, 400)}; exec sleep 30`,
      { runtime: { flowControl: { highWaterBytes: 4096, lowWaterBytes: 1024 } } },
    );
    await session.attach(1);
    await until(() => session.outputOffset > 20_000);
    await Bun.sleep(50);

    // Streaming stopped at the high-water mark during the first burst; the emulator kept parsing.
    const client = recorder.client(1);
    const streamed = client.outputBytes();
    expect(streamed).toBeGreaterThan(4096);
    expect(streamed).toBeLessThan(10_000);
    expect(client.states).toHaveLength(1);

    // Acks from an earlier sync are ignored.
    session.ack(client.states[0]!.offset + 1, streamed);
    await Bun.sleep(50);
    expect(recorder.client(1).states).toHaveLength(1);

    session.ack(client.states[0]!.offset, streamed);
    await until(() => recorder.client(1).states.length === 2);
    const resync = recorder.client(1).states[1]!;
    expect(resync.mode).toBe("snapshot");
    expect(resync.snapshot).toContain("line 0399");
    expect(resync.offset).toBe(session.outputOffset);
  });

  test("destroy settles every attach whose snapshot is still pending", async () => {
    const { session, recorder } = spawnScript("exec sleep 30");
    const attach1 = session.attach(1);
    const attach2 = session.attach(2);
    session.destroy();
    await Promise.all([attach1, attach2]);
    expect(recorder.states).toHaveLength(0);
  });

  test("a shell exiting while the client is paused gets a final snapshot before the exit", async () => {
    const line = "line %04d of output padding padding padding padding padding\\n";
    const { session, recorder, exits } = spawnScript(
      `i=0; while [ $i -lt 400 ]; do printf '${line}' $i; i=$((i+1)); done; exit 0`,
      { runtime: { flowControl: { highWaterBytes: 4096, lowWaterBytes: 1024 } } },
    );
    await session.attach(1);
    await until(() => exits.length === 1);

    expect(exits).toEqual([0]);
    const last = recorder.client(1).states.at(-1)!;
    expect(last.mode).toBe("snapshot");
    expect(last.snapshot).toContain("line 0399");
    expect(last.offset).toBe(session.outputOffset);
  });

  test("an exit is reported once the program ends", async () => {
    const { session, exits } = spawnScript("exit 3");
    await session.attach(1);
    await until(() => exits.length === 1);
    expect(exits).toEqual([3]);
  });

  test("a program that cannot start fails the constructor", () => {
    expect(
      () =>
        new TerminalSession({
          id: crypto.randomUUID(),
          epoch: crypto.randomUUID(),
          argv: ["/nonexistent/loxel-test-shell"],
          cwd: "/tmp",
          env: {},
          cols: 80,
          rows: 24,
          scrollbackLines: 1_000,
          runtime: { log: createNoopLogger() },
          emit: () => {},
          onExit: () => {},
        }),
    ).toThrow();
  });
});
