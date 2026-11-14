import { describe, expect, test } from "bun:test";

import type { CanUseTool, Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { AgentEvent, AgentRequest } from "@/api/agent-session-model";

import type { AgentLaunch } from "./agent-transport";
import { ClaudeSdkTransport, type QueryFunction } from "./claude-sdk-transport";

const launch: AgentLaunch = {
  worktreePath: "/work",
  sessionId: "0b8f3c6e-1d2a-4f5b-9c7d-8e9f0a1b2c3d",
  resume: false,
};

/**
 * A scripted SDK query: the test pushes the messages the CLI would print and calls the
 * `canUseTool` the transport registered; the transport's calls are recorded.
 */
class FakeQuery {
  options: Options | null = null;
  prompt: AsyncIterable<SDKUserMessage> | null = null;
  readonly calls: string[] = [];
  private readonly messages: unknown[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  readonly query: QueryFunction = ({ prompt, options }) => {
    this.prompt = prompt;
    this.options = options;
    const generator = this.stream();
    return Object.assign(generator, {
      initializationResult: async () => ({
        commands: [{ name: "compact", description: "Compact", argumentHint: "" }],
        models: [
          {
            value: "opus",
            resolvedModel: "claude-opus-5-5",
            displayName: "Opus",
            description: "Opus 5.5 · Best",
          },
        ],
        current_permission_mode: "auto",
        session_state: "idle",
      }),
      getSettings: async () => ({ applied: { model: "claude-opus-5-5", effort: "high" } }),
      interrupt: async () => {
        this.calls.push("interrupt");
      },
      setPermissionMode: async (mode: string) => {
        this.calls.push(`mode:${mode}`);
      },
      close: () => {
        this.calls.push("close");
        this.end();
      },
    }) as unknown as Query;
  };

  private async *stream(): AsyncGenerator {
    while (true) {
      const next = this.messages.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  emit(message: unknown): void {
    this.messages.push(message);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  canUseTool(): CanUseTool {
    const handler = this.options?.canUseTool;
    if (!handler) throw new Error("no canUseTool registered");
    return handler;
  }
}

function setup() {
  const fake = new FakeQuery();
  const events: AgentEvent[] = [];
  const exits: (string | null)[] = [];
  let exited: () => void = () => {};
  const exit = new Promise<void>((resolve) => {
    exited = resolve;
  });
  const transport = new ClaudeSdkTransport(
    launch,
    () => ({
      binary: "/usr/local/bin/claude",
      env: { PATH: "/usr/bin", CLAUDECODE: "1" },
      loxelEnv: { LOXEL: "1" },
    }),
    {
      onEvents: (e) => events.push(...e),
      onExit: (error) => {
        exits.push(error);
        exited();
      },
    },
    fake.query,
  );
  return { fake, events, exits, exit, transport };
}

function toolOptions(requestId: string, signal = new AbortController().signal) {
  return {
    signal,
    toolUseID: `toolu_${requestId}`,
    requestId,
    suggestions: [
      {
        type: "addRules" as const,
        rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
        behavior: "allow" as const,
        destination: "localSettings" as const,
      },
    ],
  };
}

describe("ClaudeSdkTransport", () => {
  test("runs the user's claude like the TUI, and reports the real starting values", async () => {
    const { fake, events, transport } = setup();
    await transport.start();
    const options = fake.options!;
    expect(options.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude");
    expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect(options.sessionId).toBe(launch.sessionId);
    expect(options.cwd).toBe("/work");
    // An agent session Loxel itself runs in does not leak into the agent's commands.
    expect(options.env?.CLAUDECODE).toBeUndefined();
    expect(options.env).toMatchObject({ LOXEL: "1", LOXEL_WORKTREE: "/work" });
    expect(events).toContainEqual({ type: "model", model: "claude-opus-5-5" });
    expect(events).toContainEqual({ type: "effort", effort: "high" });
    expect(events).toContainEqual({ type: "permission_mode", mode: "auto" });
    expect(events.find((e) => e.type === "catalog")).toMatchObject({
      commands: [{ name: "compact" }],
    });
  });

  test("a tool request becomes a card; the answer goes back with the rule saved where chosen", async () => {
    const { fake, events, transport } = setup();
    await transport.start();
    const decision = fake.canUseTool()("Bash", { command: "npm test" }, toolOptions("r1"));
    const request = events.find((e) => e.type === "request");
    expect(request?.type === "request" && request.request.kind).toBe("permission");
    const pending = (request as { request: AgentRequest }).request;

    transport.respond(pending, {
      kind: "permission",
      allow: true,
      alwaysAllow: [{ index: 0, destination: "userSettings" }],
    });
    const result = await decision;
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: { command: "npm test" },
      updatedPermissions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
          behavior: "allow",
          destination: "userSettings",
        },
      ],
    });
    expect(events).toContainEqual({ type: "request_resolved", requestId: "r1" });
  });

  test("plan approval switches mode in the same turn", async () => {
    const { fake, events, transport } = setup();
    await transport.start();
    const decision = fake.canUseTool()("ExitPlanMode", { plan: "1. Do it" }, toolOptions("p1"));
    const request = events.find((e) => e.type === "request") as { request: AgentRequest };
    expect(request.request.kind).toBe("plan");
    transport.respond(request.request, { kind: "plan", approve: true, mode: "acceptEdits" });
    expect(await decision).toEqual({
      behavior: "allow",
      updatedInput: { plan: "1. Do it" },
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
  });

  test("an interrupt that aborts a request withdraws its card", async () => {
    const { fake, events, transport } = setup();
    await transport.start();
    const abort = new AbortController();
    const decision = fake.canUseTool()("Bash", { command: "ls" }, toolOptions("r2", abort.signal));
    abort.abort();
    expect((await decision)?.behavior).toBe("deny");
    expect(events).toContainEqual({ type: "request_resolved", requestId: "r2" });
  });

  test("messages become transcript events, and a queued message waits for the turn", async () => {
    const { fake, events, transport } = setup();
    await transport.start();
    const id = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    transport.send({ id, text: "hello", images: [], delivery: "queue" });
    const sent = await fake.prompt![Symbol.asyncIterator]().next();
    expect(sent.value).toMatchObject({ uuid: id, priority: "next", origin: { kind: "human" } });

    fake.emit({
      type: "assistant",
      uuid: "a1",
      parent_tool_use_id: null,
      message: { id: "msg_1", content: [{ type: "text", text: "Hi there" }] },
    });
    fake.end();
    await transport.stop();
    expect(
      events.some((e) => e.type === "item" && e.item.kind === "text" && e.item.text === "Hi there"),
    ).toBe(true);
  });

  test("stop interrupts, closes the query and waits for the process; no error is reported", async () => {
    const { fake, exits, transport } = setup();
    await transport.start();
    await transport.stop();
    expect(fake.calls).toEqual(["interrupt", "close"]);
    expect(exits).toEqual([null]);
  });

  test("a process that ends on its own is reported", async () => {
    const { fake, exits, exit, transport } = setup();
    await transport.start();
    fake.end();
    await exit;
    expect(exits).toEqual(["Claude Code exited."]);
  });
});
