import { describe, expect, test } from "bun:test";

import type { AgentServerMessage } from "@/api/agent-session-model";

import { AgentSession } from "./agent-session";
import type { AgentTransport, AgentTransportHandlers } from "./agent-transport";

const LAUNCH = {
  worktreePath: "/p",
  sessionId: "11111111-1111-4111-8111-111111111111",
  resume: false,
};

function fakeTransport() {
  const calls: string[] = [];
  let handlers: AgentTransportHandlers | null = null;
  const transport: AgentTransport = {
    start: async () => {
      calls.push("start");
      handlers?.onEvents([{ type: "status", status: "idle" }]);
    },
    send: ({ text }) => calls.push(`send:${text}`),
    interrupt: async () => void calls.push("interrupt"),
    respond: () => calls.push("respond"),
    setPermissionMode: async (mode) => void calls.push(`mode:${mode}`),
    setModel: async () => {},
    setEffort: async () => {},
    refreshContextUsage: async () => {},
    stop: async () => void calls.push("stop"),
  };
  return {
    calls,
    emit: (error: string | null) => handlers?.onExit(error),
    factory: (_launch: unknown, h: AgentTransportHandlers) => {
      handlers = h;
      return transport;
    },
  };
}

function client() {
  const received: AgentServerMessage[] = [];
  return { received, send: (message: AgentServerMessage) => received.push(message) };
}

describe("AgentSession", () => {
  test("a new client gets a snapshot; a reconnecting one only what it missed", async () => {
    const fake = fakeTransport();
    const session = new AgentSession(LAUNCH, fake.factory);
    const first = client();
    session.attach(first);
    await session.start(false);
    expect(first.received[0]).toMatchObject({
      type: "snapshot",
      state: { sessionId: LAUNCH.sessionId },
    });

    const lastSeq = Math.max(...first.received.map((m) => ("seq" in m ? m.seq : 0)));
    const snapshot = first.received[0];
    const instanceId = snapshot?.type === "snapshot" ? snapshot.instanceId : undefined;
    await session.handle({ type: "send", id: crypto.randomUUID(), text: "hi", delivery: "queue" });

    const again = client();
    session.attach(again, { seq: lastSeq, instanceId });
    expect(again.received.map((m) => m.type)).toEqual(["event"]);

    // The same number from another server's session gets a snapshot instead.
    const stranger = client();
    session.attach(stranger, { seq: lastSeq, instanceId: "another-server" });
    expect(stranger.received.map((m) => m.type)).toEqual(["snapshot"]);
    expect(fake.calls).toEqual(["start", "send:hi"]);
  });

  test("history from the transcript is in the first snapshot", () => {
    const fake = fakeTransport();
    const session = new AgentSession({ ...LAUNCH, resume: true }, fake.factory, [
      { type: "user_message", id: "u1", text: "earlier", imageCount: 0, queued: false },
    ]);
    const c = client();
    session.attach(c);
    expect(c.received[0]).toMatchObject({
      type: "snapshot",
      state: { items: [{ text: "earlier" }] },
    });
  });

  test("a message sent while stopped is refused, not shown as queued", async () => {
    const fake = fakeTransport();
    const session = new AgentSession(LAUNCH, fake.factory);
    await expect(
      session.handle({ type: "send", id: crypto.randomUUID(), text: "x", delivery: "queue" }),
    ).rejects.toThrow("not running");
    const c = client();
    session.attach(c);
    expect(c.received[0]).toMatchObject({ state: { items: [] } });
  });

  test("a destroyed session never starts", async () => {
    const fake = fakeTransport();
    const session = new AgentSession(LAUNCH, fake.factory);
    await session.destroy();
    await session.start(false);
    expect(fake.calls).toEqual([]);
  });

  test("a hand-off stops the process, and resume starts it again on the same session", async () => {
    const fake = fakeTransport();
    const session = new AgentSession(LAUNCH, fake.factory);
    await session.start(false);
    await session.handle({ type: "hand_off" });
    const c = client();
    session.attach(c);
    expect(c.received[0]).toMatchObject({ state: { handedOff: true } });

    await expect(
      session.handle({ type: "send", id: crypto.randomUUID(), text: "x", delivery: "queue" }),
    ).rejects.toThrow("not running");

    await session.handle({ type: "resume" });
    expect(fake.calls).toEqual(["start", "stop", "start"]);
  });

  test("an exit the user did not ask for fails the session", async () => {
    const fake = fakeTransport();
    const session = new AgentSession(LAUNCH, fake.factory);
    const c = client();
    session.attach(c);
    await session.start(false);
    fake.emit("Claude Code exited with code 1");
    expect(c.received.at(-1)).toMatchObject({ type: "event", event: { type: "exited" } });
  });
});
