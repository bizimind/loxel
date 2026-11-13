import { describe, expect, test } from "bun:test";

import type { AgentServerMessage } from "@/api/agent-session-model";

import { AgentSession } from "./agent-session";
import type {
  AgentBackend,
  AgentOutgoingMessage,
  AgentTransport,
  AgentTransportSink,
} from "./agent-transport";

class FakeTransport implements AgentTransport {
  readonly sent: AgentOutgoingMessage[] = [];
  closed = false;
  mode: string | null = null;
  constructor(readonly sink: AgentTransportSink) {}
  send(message: AgentOutgoingMessage): void {
    this.sent.push(message);
  }
  async interrupt(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setEffort(): Promise<void> {}
  async setPermissionMode(mode: string): Promise<void> {
    this.mode = mode;
  }
  /** Resolve to let `close()` finish, as the process exiting would. */
  exited: () => void = () => {};
  private readonly exit = new Promise<void>((resolve) => {
    this.exited = resolve;
  });
  /** Whether `close()` waits for `exited`; otherwise the process ends at once. */
  waitForExit = false;
  close(): Promise<void> {
    this.closed = true;
    return this.waitForExit ? this.exit : Promise.resolve();
  }
}

function fakeBackend(history: unknown[] = []) {
  const started: { resumeSessionId?: string; transport: FakeTransport }[] = [];
  const backend: AgentBackend = {
    async start({ resumeSessionId, sink }) {
      const transport = new FakeTransport(sink);
      started.push({ resumeSessionId, transport });
      return transport;
    },
    async loadHistory() {
      return history;
    },
  };
  return { backend, started };
}

function recorder() {
  const messages: AgentServerMessage[] = [];
  return { messages, client: { send: (m: AgentServerMessage) => messages.push(m) } };
}

/** The status the client would show after `messages`. */
function lastStatus(messages: AgentServerMessage[]) {
  return messages.findLast((m) => m.type === "status")?.status;
}

describe("AgentSession", () => {
  test("a tool request becomes an interaction; the answer resolves it and clears needs-input", async () => {
    const { backend, started } = fakeBackend();
    const session = new AgentSession(backend, "a1", "/work");
    const { messages, client } = recorder();
    session.attach(client);
    await session.start();
    const { transport } = started[0]!;

    const decision = transport.sink.requestTool(
      { toolName: "Bash", input: { command: "ls" } },
      new AbortController().signal,
    );
    const shown = messages.find((m) => m.type === "interaction");
    expect(shown?.type === "interaction" && shown.interaction.kind).toBe("permission");
    expect(lastStatus(messages)).toBe("needs_input");

    const id = shown?.type === "interaction" ? shown.interaction.id : "";
    await session.handle({
      type: "respond",
      interactionId: id,
      response: { kind: "permission", decision: "deny", message: "no" },
    });
    expect(await decision).toEqual({
      behavior: "deny",
      message: "The user denied this tool call: no",
    });
    expect(messages.some((m) => m.type === "interaction_resolved" && m.id === id)).toBe(true);
    expect(lastStatus(messages)).toBe("idle");
  });

  test("an interrupt that aborts a request withdraws its card", async () => {
    const { backend, started } = fakeBackend();
    const session = new AgentSession(backend, "a1", "/work");
    const { messages, client } = recorder();
    session.attach(client);
    await session.start();
    const abort = new AbortController();
    const decision = started[0]!.transport.sink.requestTool(
      { toolName: "Bash", input: {} },
      abort.signal,
    );
    abort.abort();
    expect((await decision).behavior).toBe("deny");
    expect(messages.some((m) => m.type === "interaction_resolved")).toBe(true);
  });

  test("a message sent while working is queued until the agent takes it in", async () => {
    const { backend, started } = fakeBackend();
    const session = new AgentSession(backend, "a1", "/work");
    const { messages, client } = recorder();
    session.attach(client);
    await session.start();
    const { transport } = started[0]!;

    await session.handle({ type: "send", text: "first", delivery: "queue" });
    await session.handle({ type: "send", text: "second", delivery: "steer" });
    expect(transport.sent.map((m) => [m.text, m.delivery])).toEqual([
      ["first", "queue"],
      ["second", "steer"],
    ]);
    const second = transport.sent[1]!;
    const queued = messages.findLast((m) => m.type === "item" && m.item.id === second.uuid);
    expect(queued?.type === "item" && queued.item.kind === "user" && queued.item.queued).toBe(true);

    transport.sink.update({ type: "user_delivered", uuid: second.uuid });
    const delivered = messages.findLast((m) => m.type === "item" && m.item.id === second.uuid);
    expect(
      delivered?.type === "item" && delivered.item.kind === "user" && delivered.item.queued,
    ).toBe(false);
  });

  test("hand-off names the resume command only once the process has exited, to the window that asked", async () => {
    const { backend, started } = fakeBackend();
    const session = new AgentSession(backend, "a1", "/work");
    const asker = recorder();
    const other = recorder();
    session.attach(asker.client);
    session.attach(other.client);
    await session.start();
    const { transport } = started[0]!;
    transport.sink.update({
      type: "info",
      patch: { sessionId: "0b8f3c6e-1d2a-4f5b-9c7d-8e9f0a1b2c3d" },
    });
    transport.waitForExit = true;

    const handOff = session.handle({ type: "hand_off" }, asker.client);
    await Promise.resolve();
    expect(transport.closed).toBe(true);
    expect(asker.messages.some((m) => m.type === "handed_off")).toBe(false);
    transport.exited();
    await handOff;
    expect(asker.messages.filter((m) => m.type === "handed_off")).toHaveLength(1);
    expect(other.messages.some((m) => m.type === "handed_off")).toBe(false);
    expect(lastStatus(other.messages)).toBe("handed_off");
  });

  test("a panel restored while handed off shows its transcript but does not start", async () => {
    const history = [{ type: "user", uuid: "h1", message: { content: "earlier" } }];
    const { backend, started } = fakeBackend(history);
    const session = new AgentSession(backend, "a1", "/work");
    await session.start("0b8f3c6e-1d2a-4f5b-9c7d-8e9f0a1b2c3d", { handedOff: true });
    expect(started).toHaveLength(0);
    expect(session.status).toBe("handed_off");
  });

  test("resuming while the agent runs ends the old process first", async () => {
    const { backend, started } = fakeBackend();
    const session = new AgentSession(backend, "a1", "/work");
    await session.start();
    const first = started[0]!.transport;
    const pending = first.sink.requestTool(
      { toolName: "Bash", input: {} },
      new AbortController().signal,
    );
    await session.handle({ type: "resume" });
    expect(first.closed).toBe(true);
    expect((await pending).behavior).toBe("deny");
    expect(started).toHaveLength(2);
    expect(session.status).toBe("idle");
  });

  test("an untrusted repository does not start the agent", async () => {
    const { backend, started } = fakeBackend();
    const session = new AgentSession(backend, "a1", "/work", async () => "Trust it first.");
    await session.start();
    expect(started).toHaveLength(0);
    expect(session.status).toBe("failed");
  });

  test("an interrupted turn shows as interrupted, not as an error", async () => {
    const { backend, started } = fakeBackend();
    const session = new AgentSession(backend, "a1", "/work");
    const { messages, client } = recorder();
    session.attach(client);
    await session.start();
    await session.handle({ type: "send", text: "go", delivery: "queue" });
    await session.handle({ type: "interrupt" });
    started[0]!.transport.sink.update({
      type: "turn_end",
      error: "error_during_execution",
      costUsd: null,
    });
    const notices = messages.flatMap((m) =>
      m.type === "item" && m.item.kind === "notice" ? [m.item] : [],
    );
    expect(notices.map((n) => [n.text, n.tone])).toEqual([["Interrupted.", "info"]]);
  });

  test("hand-off stops the agent and names the resume command; resume restarts it with history", async () => {
    const history = [{ type: "user", uuid: "h1", message: { content: "earlier question" } }];
    const { backend, started } = fakeBackend(history);
    const session = new AgentSession(backend, "a1", "/work");
    const { messages, client } = recorder();
    session.attach(client);
    await session.start();
    started[0]!.transport.sink.update({
      type: "info",
      patch: { sessionId: "0b8f3c6e-1d2a-4f5b-9c7d-8e9f0a1b2c3d" },
    });

    await session.handle({ type: "hand_off" }, client);
    expect(started[0]!.transport.closed).toBe(true);
    expect(messages.find((m) => m.type === "handed_off")).toEqual({
      type: "handed_off",
      command: "claude --resume 0b8f3c6e-1d2a-4f5b-9c7d-8e9f0a1b2c3d",
      cwd: "/work",
    });
    expect(session.status).toBe("handed_off");

    // Updates from the replaced transport are ignored.
    started[0]!.transport.sink.update({ type: "activity", state: "working" });
    expect(session.status).toBe("handed_off");

    await session.handle({ type: "resume" });
    expect(started[1]?.resumeSessionId).toBe("0b8f3c6e-1d2a-4f5b-9c7d-8e9f0a1b2c3d");
    const snapshot = messages.findLast((m) => m.type === "snapshot");
    expect(snapshot?.type === "snapshot" && snapshot.snapshot.items.map((i) => i.id)).toEqual([
      "h1",
    ]);
    expect(session.status).toBe("idle");
  });

  test("hand-off before the agent has a session explains why it cannot", async () => {
    const { backend } = fakeBackend();
    const session = new AgentSession(backend, "a1", "/work");
    const { messages, client } = recorder();
    session.attach(client);
    await session.start();
    await session.handle({ type: "hand_off" });
    const notice = messages.findLast((m) => m.type === "item" && m.item.kind === "notice");
    expect(notice?.type === "item" && notice.item.kind === "notice" && notice.item.tone).toBe(
      "error",
    );
    expect(session.status).toBe("idle");
  });

  test("a backend that cannot start fails the session with its reason", async () => {
    const backend: AgentBackend = {
      start: () => Promise.reject(new Error("no claude on PATH")),
      loadHistory: async () => [],
    };
    const session = new AgentSession(backend, "a1", "/work");
    const { messages, client } = recorder();
    session.attach(client);
    await session.start();
    expect(session.status).toBe("failed");
    const info = messages.findLast((m) => m.type === "info");
    expect(info?.type === "info" && info.info.error).toBe("no claude on PATH");
  });

  test("the permission mode switches live", async () => {
    const { backend, started } = fakeBackend();
    const session = new AgentSession(backend, "a1", "/work");
    await session.start();
    await session.handle({ type: "set_permission_mode", mode: "plan" });
    expect(started[0]!.transport.mode).toBe("plan");
  });
});
