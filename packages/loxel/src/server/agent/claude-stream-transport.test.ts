import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  type AgentEvent,
  type AgentState,
  agentDisplayStatus,
  applyAgentEvent,
  INITIAL_AGENT_STATE,
} from "@/api/agent-session-model";

import {
  ClaudeStreamTransport,
  claudeStreamArgs,
  permissionResult,
} from "./claude-stream-transport";
import { StreamReplay } from "./stream-replay";

const LAUNCH = {
  worktreePath: "/Users/dev/project",
  sessionId: "4a1583e2-ed62-4861-b4fa-0f48a6dc1579",
  resume: false,
};

async function replay(name: string) {
  const recording = new StreamReplay(
    await Bun.file(join(import.meta.dir, "fixtures", name)).text(),
  );
  let state: AgentState = INITIAL_AGENT_STATE;
  const events: AgentEvent[] = [];
  const exits: (string | null)[] = [];
  const transport = new ClaudeStreamTransport(LAUNCH, () => recording.process(), {
    onEvents: (batch) => {
      for (const event of batch) {
        events.push(event);
        state = applyAgentEvent(state, event);
      }
    },
    onExit: (error) => exits.push(error),
  });
  recording.bind(transport);
  return { recording, transport, events, exits, state: () => state };
}

function userMessage(text: string) {
  return { id: crypto.randomUUID(), text, images: [], delivery: "queue" as const };
}

describe("ClaudeStreamTransport", () => {
  test("starts in print mode with the prompt tool on stdio and a session of its own", () => {
    const args = claudeStreamArgs(LAUNCH);
    expect(args).toContain("--permission-prompt-tool");
    expect(args.slice(args.indexOf("--session-id"))[1]).toBe(LAUNCH.sessionId);
    expect(claudeStreamArgs({ ...LAUNCH, resume: true })).toContain("--resume");
  });

  test("answers AskUserQuestion with the chosen label", async () => {
    const { recording, transport, state } = await replay("ask-user-question.ndjson");
    const started = transport.start();
    transport.send(userMessage("Run echo"));
    await started;

    expect(state().commands.map((c) => c.name)).toEqual(["compact", "review", "context"]);
    // The effective model and effort are known before the first turn's init.
    expect(state().model).toBe("claude-haiku-5-5");
    expect(state().effort).toBe("high");
    expect(state().models.find((m) => m.value === "opus")?.effortLevels).toContain("max");
    expect(state().status).toBe("idle");
    const echo = state().items.find((item) => item.kind === "tool" && item.name === "Bash");
    expect(echo?.kind === "tool" && echo.result?.text).toBe("probe-hello");

    transport.send(userMessage("Ask me"));
    const [question] = state().pending;
    expect(question?.kind).toBe("question");
    if (question?.kind !== "question") return;
    expect(question.questions[0]?.question).toBe("Pick a color");
    expect(question.questions[0]?.options.map((o) => o.label)).toEqual(["Red", "Blue"]);
    expect(agentDisplayStatus(state())).toBe("needs_input");

    transport.respond(question, { kind: "question", answers: { "Pick a color": "Blue" } });
    expect(state().pending).toEqual([]);
    expect(state().status).toBe("idle");
    expect(recording.remaining()).toEqual([]);
    const answer = recording.written.at(-1);
    expect(JSON.stringify(answer)).toContain('"answers":{"Pick a color":"Blue"}');
  });

  test("approves a plan in-turn and switches to the chosen mode", async () => {
    const { recording, transport, state } = await replay("plan-approval.ndjson");
    const started = transport.start();
    transport.send(userMessage("Create hello.txt"));
    await started;
    expect(state().permissionMode).toBe("default");

    const usage = transport.refreshContextUsage();
    const mode = transport.setPermissionMode("plan");
    transport.send(userMessage("Plan bye.txt"));
    await Promise.all([usage, mode]);
    expect(state().contextUsage?.maxTokens).toBeGreaterThan(0);

    const [plan] = state().pending;
    expect(plan?.kind).toBe("plan");
    if (plan?.kind !== "plan") return;
    expect(plan.plan).toContain("bye.txt");

    transport.respond(plan, { kind: "plan", approve: true, mode: "acceptEdits" });
    expect(state().permissionMode).toBe("acceptEdits");
    expect(state().status).toBe("idle");
    expect(recording.remaining()).toEqual([]);
  });

  test("shows a Bash ask with the rule its 'don't ask again' would save", async () => {
    const { transport, state } = await replay("bash-permission.ndjson");
    const started = transport.start();
    transport.send(userMessage("npm --version"));
    await started;

    const [ask] = state().pending;
    expect(ask?.kind).toBe("permission");
    if (ask?.kind !== "permission") return;
    expect(ask.toolName).toBe("Bash");
    expect(ask.suggestions.map((s) => [s.label, s.destination])).toEqual([
      ["Bash(npm --version)", "localSettings"],
    ]);
    transport.respond(ask, { kind: "permission", allow: true });
    expect(state().status).toBe("idle");
  });

  test("stop ends the process without reporting an error", async () => {
    const { transport, exits } = await replay("bash-permission.ndjson");
    const started = transport.start();
    transport.send(userMessage("npm --version"));
    await started;
    // The recording has no answer to the interrupt stop sends first, so the replay rejects it.
    await transport.stop();
    expect(exits).toEqual([null]);
  });
});

describe("permissionResult", () => {
  const plan = {
    kind: "plan" as const,
    requestId: "r1",
    toolUseId: "t1",
    input: { plan: "do it" },
    plan: "do it",
  };

  test("keep planning denies with the user's feedback", () => {
    expect(permissionResult(plan, { kind: "plan", approve: false, feedback: "smaller" })).toEqual({
      behavior: "deny",
      message: "smaller",
    });
  });

  const ask = {
    kind: "permission" as const,
    requestId: "r2",
    toolName: "Bash",
    displayName: "Bash",
    toolUseId: "t2",
    input: { command: "npm --version" },
    suggestions: [
      {
        update: { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm --version" }] },
        label: "Bash(npm --version)",
        destination: "localSettings",
      },
    ],
    suppressAlwaysAllow: false,
    defaultToNo: false,
  };

  test("always allow saves only the agent's own suggestion, where the user chose", () => {
    const result = permissionResult(ask, {
      kind: "permission",
      allow: true,
      alwaysAllow: [
        { index: 0, destination: "session" },
        { index: 7, destination: "userSettings" },
      ],
    });
    expect(result.updatedPermissions).toEqual([
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "npm --version" }],
        destination: "session",
      },
    ]);
    const suppressed = permissionResult(
      { ...ask, suppressAlwaysAllow: true },
      { kind: "permission", allow: true, alwaysAllow: [{ index: 0, destination: "session" }] },
    );
    expect(suppressed.updatedPermissions).toBeUndefined();
  });

  test("an approved plan without a mode keeps the session's mode", () => {
    expect(permissionResult(plan, { kind: "plan", approve: true })).toEqual({
      behavior: "allow",
      updatedInput: { plan: "do it" },
    });
  });
});
