import { describe, expect, test } from "bun:test";

import type { AgentServerMessage } from "@/api/agent-session-model";

import { AgentManager } from "./agent-manager";
import type { AgentTransport } from "./agent-transport";

const AGENT_ID = "22222222-2222-4222-8222-222222222222";

function client() {
  const received: AgentServerMessage[] = [];
  return { received, send: (message: AgentServerMessage) => received.push(message) };
}

describe("AgentManager", () => {
  test("a panel closed while its session is created never leaves a process behind", async () => {
    let releaseHistory: (events: []) => void = () => {};
    const started: string[] = [];
    const manager = new AgentManager({
      startingEvents: async () => [],
      loadHistory: () =>
        new Promise((resolve) => {
          releaseHistory = resolve;
        }),
      createTransport: () => {
        const transport: AgentTransport = {
          start: async () => void started.push("start"),
          send: () => {},
          interrupt: async () => {},
          respond: () => {},
          setPermissionMode: async () => {},
          setModel: async () => {},
          setEffort: async () => {},
          refreshContextUsage: async () => {},
          stop: async () => void started.push("stop"),
        };
        return transport;
      },
    });
    const c = client();
    const attaching = manager.handle(AGENT_ID, c, {
      type: "attach",
      worktreePath: "/p",
      resumeSessionId: "33333333-3333-4333-8333-333333333333",
    });
    const destroying = manager.handle(AGENT_ID, c, { type: "destroy" });
    releaseHistory([]);
    await Promise.all([attaching, destroying]);
    // Started and stopped, or never started: either way nothing runs.
    expect(started.filter((s) => s === "start").length).toBe(
      started.filter((s) => s === "stop").length,
    );
    expect(c.received.some((m) => m.type === "error")).toBe(false);
  });

  test("an attach that fails tells the client", async () => {
    const manager = new AgentManager({
      startingEvents: async () => [],
      loadHistory: () => Promise.reject(new Error("EACCES")),
      createTransport: () => {
        throw new Error("unreachable");
      },
    });
    const c = client();
    await manager.handle(AGENT_ID, c, {
      type: "attach",
      worktreePath: "/p",
      resumeSessionId: "33333333-3333-4333-8333-333333333333",
    });
    expect(c.received).toEqual([{ type: "error", message: "EACCES" }]);
  });
});
