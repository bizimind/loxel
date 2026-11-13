import { describe, expect, test } from "bun:test";

import { AgentManager, type AgentSocket } from "./agent-manager";
import type { AgentBackend, AgentTransport } from "./agent-transport";

function backend() {
  let starts = 0;
  const transport: AgentTransport = {
    send() {},
    interrupt: async () => {},
    setModel: async () => {},
    setEffort: async () => {},
    setPermissionMode: async () => {},
    close: async () => {},
  };
  const value: AgentBackend = {
    async start() {
      starts += 1;
      return transport;
    },
    loadHistory: async () => [],
  };
  return { value, starts: () => starts };
}

function socket(): AgentSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    data: { type: "agent", session: null, client: null },
    send: (text) => sent.push(text),
    close() {},
  };
}

const attach = (agentId: string) => JSON.stringify({ type: "attach", agentId, cwd: "/work" });

describe("AgentManager", () => {
  test("two sockets for one panel share one session", async () => {
    const b = backend();
    const manager = new AgentManager(b.value, async () => null);
    const first = socket();
    const second = socket();
    await Promise.all([
      manager.handleMessage(first, attach("a1")),
      manager.handleMessage(second, attach("a1")),
    ]);
    expect(first.data.session).toBe(second.data.session);
    expect(first.data.session).not.toBeNull();
  });

  test("a socket that closed before its attach is not bound", async () => {
    const manager = new AgentManager(backend().value, async () => null);
    const ws = socket();
    manager.detach(ws);
    await manager.handleMessage(ws, attach("a1"));
    expect(ws.data.session).toBeNull();
  });

  test("malformed messages and session ids are ignored", async () => {
    const manager = new AgentManager(backend().value, async () => null);
    const ws = socket();
    await manager.handleMessage(ws, "not json");
    await manager.handleMessage(
      ws,
      JSON.stringify({
        type: "attach",
        agentId: "a1",
        cwd: "/work",
        resumeSessionId: "$(rm -rf ~)",
      }),
    );
    expect(ws.data.session).toBeNull();
  });

  test("sessions no window shows are ended; shown ones are kept", async () => {
    const manager = new AgentManager(backend().value, async () => null);
    const shown = socket();
    const gone = socket();
    await manager.handleMessage(shown, attach("a1"));
    await manager.handleMessage(gone, attach("a2"));
    manager.detach(gone);
    expect(manager.disposeDetached()).toBe(1);
    expect(manager.disposeDetached()).toBe(0);
  });
});
