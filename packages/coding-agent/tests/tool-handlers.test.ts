import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";

import { READ_LIMITS } from "../src/core/constants.ts";
import { PermissionStore } from "../src/permissions/store.ts";
import { SessionStore } from "../src/session/store.ts";
import { normalizeDeclaredTools } from "../src/tools/capabilities.ts";
import type { ToolRuntimeContext } from "../src/tools/context.ts";
import { invokeToolByName } from "../src/tools/handlers.ts";
import { TaskManager } from "../src/tools/task-manager.ts";

const originalHome = process.env.HOME;
const originalStateRoot = process.env.CODING_AGENT_STATE_ROOT;
const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
const originalWebsearchModel = process.env.OPENROUTER_WEBSEARCH_MODEL;
const originalFetch = globalThis.fetch;

function tempWorkspace(): string {
  return path.join(
    process.cwd(),
    "tmp-test-workspace",
    `tools-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
}

describe("tool handlers", () => {
  let testHome: string;
  const workspaces: string[] = [];

  beforeEach(() => {
    testHome = path.join(process.cwd(), "tmp-test-home", `tools-${Date.now()}`);
    process.env.HOME = testHome;
    process.env.CODING_AGENT_STATE_ROOT = path.join(
      testHome,
      ".local",
      "state",
      "loxel",
      "coding-agent",
    );
  });

  afterEach(async () => {
    await rm(testHome, { recursive: true, force: true });
    for (const workspace of workspaces.splice(0, workspaces.length)) {
      await rm(workspace, { recursive: true, force: true });
    }
    await rm(path.join(process.cwd(), "tmp-test-home"), { recursive: true, force: true });
    await rm(path.join(process.cwd(), "tmp-test-workspace"), { recursive: true, force: true });
    process.env.HOME = originalHome;
    process.env.CODING_AGENT_STATE_ROOT = originalStateRoot;
    process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    process.env.OPENROUTER_WEBSEARCH_MODEL = originalWebsearchModel;
    globalThis.fetch = originalFetch;
  });

  async function createContext(options?: {
    mode?: "execute" | "plan";
    profile?: "execute" | "plan" | "minimal";
    onApproval?: ToolRuntimeContext["onApproval"];
    onHumanQuestion?: ToolRuntimeContext["onHumanQuestion"];
    approvalOverrides?: ToolRuntimeContext["approvalOverrides"];
    emitEvent?: ToolRuntimeContext["emitEvent"];
    declaredTools?: string[] | null;
  }): Promise<ToolRuntimeContext> {
    const mode = options?.mode ?? "execute";
    const workspaceRoot = tempWorkspace();
    workspaces.push(workspaceRoot);
    await mkdir(workspaceRoot, { recursive: true });

    const sessionStore = new SessionStore();
    const session = await sessionStore.createSession({
      workspaceRoot,
      mode,
      profile: options?.profile ?? (mode === "plan" ? "plan" : "execute"),
      declaredTools: options?.declaredTools ?? null,
    });

    if (mode === "plan") {
      const planPath = path.join(workspaceRoot, "plan.md");
      await Bun.write(planPath, "# plan\n");
      session.state.plan.planFilePath = planPath;
      await sessionStore.setState(session, session.state);
    }

    return {
      workspaceRoot,
      session,
      sessionStore,
      permissionStore: new PermissionStore(workspaceRoot, session.id),
      taskManager: new TaskManager(path.join(workspaceRoot, ".tasks")),
      profile: session.state.profile,
      runId: "run_test",
      declaredTools: normalizeDeclaredTools(options?.declaredTools ?? null) ?? undefined,
      approvalOverrides: options?.approvalOverrides,
      emitEvent: options?.emitEvent ?? (async () => {}),
      onHumanQuestion: options?.onHumanQuestion ?? (async () => ({ answers: { q1: ["a"] } })),
      onApproval: options?.onApproval ?? (async () => "allow"),
    };
  }

  test("Write then Read roundtrip", async () => {
    const ctx = await createContext({ mode: "execute" });

    const writeResult = await invokeToolByName(
      "Write",
      { file_path: "a.txt", content: "line1\nline2" },
      ctx,
    );
    expect(writeResult.ok).toBe(true);

    const readResult = await invokeToolByName("Read", { file_path: "a.txt" }, ctx);
    expect(readResult.ok).toBe(true);

    if (readResult.ok) {
      const lines = readResult.value as { lines: Array<{ text: string }> };
      expect(lines.lines[0]?.text).toBe("line1");
    }
  });

  test("Read blocks paths outside workspace root", async () => {
    const ctx = await createContext({ mode: "execute" });
    const result = await invokeToolByName("Read", { file_path: "../outside.txt" }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TOOL_POLICY_VIOLATION");
    }
  });

  test("Glob blocks search roots outside workspace root", async () => {
    const ctx = await createContext({ mode: "execute" });
    const result = await invokeToolByName("Glob", { pattern: "*", path: ".." }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TOOL_POLICY_VIOLATION");
    }
  });

  test("Glob blocks parent-traversal patterns", async () => {
    const ctx = await createContext({ mode: "execute" });
    const result = await invokeToolByName("Glob", { pattern: "../**/*" }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TOOL_POLICY_VIOLATION");
    }
  });

  test("Grep blocks search roots outside workspace root", async () => {
    const ctx = await createContext({ mode: "execute" });
    const result = await invokeToolByName("Grep", { pattern: "foo", path: ".." }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TOOL_POLICY_VIOLATION");
    }
  });

  test("Grep treats leading-dash patterns as literals", async () => {
    const ctx = await createContext({ mode: "execute" });
    await Bun.write(path.join(ctx.workspaceRoot, "grep.txt"), "alpha\nbeta\n");

    const result = await invokeToolByName("Grep", { pattern: "--help", path: "." }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = result.value as { total_matches: number };
      expect(output.total_matches).toBe(0);
    }
  });

  test("Read blocks symlink escapes outside workspace root", async () => {
    const ctx = await createContext({ mode: "execute" });
    const outsideDir = path.join(testHome, "outside");
    await mkdir(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, "secret.txt");
    await Bun.write(outsideFile, "secret");

    const linkPath = path.join(ctx.workspaceRoot, "escape-link");
    await symlink(outsideDir, linkPath);

    const result = await invokeToolByName("Read", { file_path: "escape-link/secret.txt" }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TOOL_POLICY_VIOLATION");
    }
  });

  test("Plan mode blocks non-plan file mutation", async () => {
    const ctx = await createContext({ mode: "plan" });
    const result = await invokeToolByName("Write", { file_path: "not-plan.md", content: "x" }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TOOL_POLICY_VIOLATION");
    }
  });

  test("Plan mode allows editing configured plan file outside workspace", async () => {
    const ctx = await createContext({ mode: "plan" });
    const externalPlanPath = path.join(testHome, "global-plan.md");
    await Bun.write(externalPlanPath, "# Plan\n");
    ctx.session.state.plan.planFilePath = externalPlanPath;
    await ctx.sessionStore.setState(ctx.session, ctx.session.state);

    const result = await invokeToolByName(
      "Write",
      { file_path: externalPlanPath, content: "- [>] outside plan file\n", override: true },
      ctx,
    );

    expect(result.ok).toBe(true);
    const updated = await Bun.file(externalPlanPath).text();
    expect(updated.includes("outside plan file")).toBe(true);
  });

  test("TaskOutput returns runtime error for unknown task", async () => {
    const ctx = await createContext({ mode: "execute" });
    const result = await invokeToolByName(
      "TaskOutput",
      { task_id: "missing", block: false, timeout: 1 },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TOOL_RUNTIME_ERROR");
    }
  });

  test("TaskOutput blocks task_id path traversal out of artifact dir", async () => {
    const ctx = await createContext({ mode: "execute" });
    const leakedTaskPath = path.join(ctx.workspaceRoot, "leaked-task.json");
    await Bun.write(
      leakedTaskPath,
      `${JSON.stringify(
        {
          id: "../leaked-task",
          type: "subagent",
          status: "completed",
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          commandOrPrompt: "leak",
          stdout: "leaked",
          stderr: "",
          exitCode: 0,
          artifactPath: null,
        },
        null,
        2,
      )}\n`,
    );

    const result = await invokeToolByName(
      "TaskOutput",
      { task_id: "../leaked-task", block: false, timeout: 1 },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TOOL_RUNTIME_ERROR");
    }
  });

  test("returns TOOL_VALIDATION_UNKNOWN_FIELD on unknown params", async () => {
    const ctx = await createContext({ mode: "execute" });
    const result = await invokeToolByName("Read", { file_path: "a.txt", nope: true }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TOOL_VALIDATION_UNKNOWN_FIELD");
    }
  });

  test("unknown tool returns TOOL_NOT_AVAILABLE", async () => {
    const ctx = await createContext({ mode: "execute" });
    const result = await invokeToolByName("DoesNotExist", {}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TOOL_NOT_AVAILABLE");
    }
  });

  test("supports compatibility alias WriteTodo -> TodoWrite", async () => {
    const ctx = await createContext({ mode: "execute" });
    const result = await invokeToolByName(
      "WriteTodo",
      { todos: [{ content: "Do it", status: "in_progress", activeForm: "Doing it" }] },
      ctx,
    );

    expect(result.ok).toBe(true);
    const readResult = await invokeToolByName("TodoRead", {}, ctx);
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      const output = readResult.value as { todos: Array<{ content: string }> };
      expect(output.todos[0]?.content).toBe("Do it");
    }
  });

  test("profile gating blocks write in minimal profile", async () => {
    const ctx = await createContext({ mode: "execute", profile: "minimal" });
    const result = await invokeToolByName("Write", { file_path: "a.txt", content: "x" }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TOOL_NOT_IN_PROFILE");
    }
  });

  test("declared tools gating blocks undeclared tool", async () => {
    const ctx = await createContext({ mode: "execute", declaredTools: ["Read", "ToolSearch"] });
    const result = await invokeToolByName("Write", { file_path: "a.txt", content: "x" }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TOOL_NOT_AVAILABLE");
    }
  });

  test("allow_this_session persists and skips next approval", async () => {
    let approvals = 0;
    const ctx = await createContext({
      mode: "execute",
      onApproval: async () => {
        approvals += 1;
        return "allow_this_session";
      },
    });

    const input = { file_path: "persist.txt", content: "same", override: true };
    const first = await invokeToolByName("Write", input, ctx);
    expect(first.ok).toBe(true);
    expect(approvals).toBe(1);

    const second = await invokeToolByName("Write", input, ctx);
    expect(second.ok).toBe(true);
    expect(approvals).toBe(1);
  });

  test("approval deny returns TOOL_PERMISSION_DENIED", async () => {
    const ctx = await createContext({ mode: "execute", onApproval: async () => "deny" });
    const result = await invokeToolByName("Write", { file_path: "deny.txt", content: "x" }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TOOL_PERMISSION_DENIED");
    }
  });

  test("approval override deny takes precedence over callback", async () => {
    let callbackCount = 0;
    const ctx = await createContext({
      mode: "execute",
      approvalOverrides: { Write: "deny" },
      onApproval: async () => {
        callbackCount += 1;
        return "allow";
      },
    });
    const result = await invokeToolByName("Write", { file_path: "x.txt", content: "x" }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TOOL_PERMISSION_DENIED");
    }
    expect(callbackCount).toBe(0);
  });

  test("approval override allow bypasses callback", async () => {
    let callbackCount = 0;
    const ctx = await createContext({
      mode: "execute",
      approvalOverrides: { Write: "allow" },
      onApproval: async () => {
        callbackCount += 1;
        return "deny";
      },
    });
    const result = await invokeToolByName("Write", { file_path: "allow.txt", content: "x" }, ctx);
    expect(result.ok).toBe(true);
    expect(callbackCount).toBe(0);
  });

  test("approval decisions are tracked in session timeline", async () => {
    const ctx = await createContext({ mode: "execute", onApproval: async () => "allow" });
    const result = await invokeToolByName("Write", { file_path: "audit.txt", content: "x" }, ctx);
    expect(result.ok).toBe(true);

    const loaded = await ctx.sessionStore.loadSession(ctx.session.id);
    expect(loaded.approvals.length).toBeGreaterThan(0);
    expect(loaded.approvals.at(-1)?.toolName).toBe("Write");
    const events = await ctx.sessionStore.readEvents(ctx.session.id);
    expect(events.some((event) => event.type === "approval.decision.recorded")).toBe(true);
  });

  test("allow_always persists across sessions", async () => {
    const workspaceRoot = tempWorkspace();
    workspaces.push(workspaceRoot);
    await mkdir(workspaceRoot, { recursive: true });

    const storeA = new SessionStore();
    const sessionA = await storeA.createSession({ workspaceRoot, profile: "execute" });
    let approvalsA = 0;
    const ctxA: ToolRuntimeContext = {
      workspaceRoot,
      session: sessionA,
      sessionStore: storeA,
      permissionStore: new PermissionStore(workspaceRoot, sessionA.id),
      taskManager: new TaskManager(path.join(workspaceRoot, ".tasks-a")),
      profile: "execute",
      runId: "run_a",
      emitEvent: async () => {},
      onHumanQuestion: async () => ({ answers: { q1: ["a"] } }),
      onApproval: async () => {
        approvalsA += 1;
        return "allow_always";
      },
    };

    const input = { file_path: "global.txt", content: "persist-project", override: true };
    const first = await invokeToolByName("Write", input, ctxA);
    expect(first.ok).toBe(true);
    expect(approvalsA).toBe(1);

    const storeB = new SessionStore();
    const sessionB = await storeB.createSession({ workspaceRoot, profile: "execute" });
    let approvalsB = 0;
    const ctxB: ToolRuntimeContext = {
      workspaceRoot,
      session: sessionB,
      sessionStore: storeB,
      permissionStore: new PermissionStore(workspaceRoot, sessionB.id),
      taskManager: new TaskManager(path.join(workspaceRoot, ".tasks-b")),
      profile: "execute",
      runId: "run_b",
      emitEvent: async () => {},
      onHumanQuestion: async () => ({ answers: { q1: ["a"] } }),
      onApproval: async () => {
        approvalsB += 1;
        return "allow";
      },
    };

    const second = await invokeToolByName("Write", input, ctxB);
    expect(second.ok).toBe(true);
    expect(approvalsB).toBe(0);
  });

  test("enter and exit plan mode approval flow", async () => {
    const ctx = await createContext({ mode: "execute", onApproval: async () => "allow" });

    const entered = await invokeToolByName("EnterPlanMode", {}, ctx);
    expect(entered.ok).toBe(true);
    if (entered.ok) {
      const out = entered.value as { plan_file_path: string };
      expect(out.plan_file_path.includes(".local/state/loxel/coding-agent")).toBe(true);
      expect(out.plan_file_path.includes(ctx.workspaceRoot)).toBe(false);
    }

    const deniedCtx = { ...ctx, onApproval: async () => "deny" as const };
    const denied = await invokeToolByName("ExitPlanMode", {}, deniedCtx);
    expect(denied.ok).toBe(true);
    if (denied.ok) {
      const out = denied.value as { approved: boolean; mode: string };
      expect(out.approved).toBe(false);
      expect(out.mode).toBe("plan");
    }

    const approvedCtx = { ...ctx, onApproval: async () => "allow" as const };
    const approved = await invokeToolByName("ExitPlanMode", {}, approvedCtx);
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      const out = approved.value as { approved: boolean; mode: string };
      expect(out.approved).toBe(true);
      expect(out.mode).toBe("execute");
    }
  });

  test("plan file edits update structured plan steps", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ctx = await createContext({
      mode: "execute",
      emitEvent: async (type, payload) => {
        events.push({ type, payload });
      },
    });

    const entered = await invokeToolByName("EnterPlanMode", {}, ctx);
    expect(entered.ok).toBe(true);
    if (!entered.ok) {
      return;
    }

    const planFilePath = (entered.value as { plan_file_path: string }).plan_file_path;
    const wrote = await invokeToolByName(
      "Write",
      {
        file_path: planFilePath,
        content: "- [ ] gather requirements\n- [>] implement feature\n- [x] tests passing\n",
        override: true,
      },
      ctx,
    );
    expect(wrote.ok).toBe(true);
    expect(ctx.session.state.plan.steps.length).toBe(3);
    expect(ctx.session.state.plan.steps[1]?.status).toBe("in_progress");
    expect(events.some((event) => event.type === "plan.updated")).toBe(true);
  });

  test("plan parsing keeps only one in_progress step", async () => {
    const ctx = await createContext({ mode: "execute" });
    const entered = await invokeToolByName("EnterPlanMode", {}, ctx);
    expect(entered.ok).toBe(true);
    if (!entered.ok) {
      return;
    }

    const planFilePath = (entered.value as { plan_file_path: string }).plan_file_path;
    const wrote = await invokeToolByName(
      "Write",
      { file_path: planFilePath, content: "- [>] one\n- [>] two\n- [ ] three\n", override: true },
      ctx,
    );
    expect(wrote.ok).toBe(true);
    const inProgress = ctx.session.state.plan.steps.filter((step) => step.status === "in_progress");
    expect(inProgress.length).toBe(1);
    expect(ctx.session.state.plan.steps[1]?.status).toBe("pending");
  });

  test("task mode cannot bypass plan constraints", async () => {
    const ctx = await createContext({ mode: "plan" });
    const result = await invokeToolByName(
      "Task",
      {
        description: "Run subagent",
        prompt: "Do the thing",
        subagent_type: "worker",
        mode: "bypassPermissions",
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TOOL_POLICY_VIOLATION");
    }
  });

  test("bash background task integrates with TaskOutput and TaskStop", async () => {
    const ctx = await createContext({ mode: "execute" });

    const launched = await invokeToolByName(
      "Bash",
      { command: "sleep 30", run_in_background: true },
      ctx,
    );
    expect(launched.ok).toBe(true);
    if (!launched.ok) {
      return;
    }

    const launchOut = launched.value as { backgroundTaskId?: string };
    expect(typeof launchOut.backgroundTaskId).toBe("string");
    const taskId = launchOut.backgroundTaskId!;

    const poll = await invokeToolByName(
      "TaskOutput",
      { task_id: taskId, block: false, timeout: 50 },
      ctx,
    );
    expect(poll.ok).toBe(true);

    const stopped = await invokeToolByName("TaskStop", { task_id: taskId }, ctx);
    expect(stopped.ok).toBe(true);
    if (stopped.ok) {
      const out = stopped.value as { stopped: boolean };
      expect(out.stopped).toBe(true);
    }
  });

  test("Task supports resume with same task id", async () => {
    const ctx = await createContext({ mode: "execute" });
    const first = await invokeToolByName(
      "Task",
      { description: "First pass", prompt: "Do first pass", subagent_type: "worker" },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const taskId = (first.value as { task_id: string }).task_id;
    const resumed = await invokeToolByName(
      "Task",
      { description: "Resume pass", prompt: "Continue", subagent_type: "worker", resume: taskId },
      ctx,
    );
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      const output = resumed.value as { task_id: string };
      expect(output.task_id).toBe(taskId);
    }
  });

  test("replay reconstructs subagent relations from Task events", async () => {
    const ctx = await createContext({ mode: "execute" });
    const created = await invokeToolByName(
      "Task",
      {
        description: "Investigate module",
        prompt: "Inspect the module and summarize findings",
        subagent_type: "worker",
        run_in_background: true,
      },
      ctx,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const taskId = (created.value as { task_id: string }).task_id;
    await invokeToolByName("TaskOutput", { task_id: taskId, block: false, timeout: 50 }, ctx);

    const replayed = await ctx.sessionStore.loadSession(ctx.session.id);
    const subagent = replayed.subagents[taskId];
    expect(subagent).toBeDefined();
    expect(subagent?.parentAgentId).toBe("main");
    expect(subagent?.subagentType).toBe("worker");
    if (subagent) {
      expect(["running", "completed", "failed", "cancelled"]).toContain(subagent.status);
    }
  });

  test("TaskOutput can read persisted task from disk across manager instances", async () => {
    const workspaceRoot = tempWorkspace();
    workspaces.push(workspaceRoot);
    await mkdir(workspaceRoot, { recursive: true });

    const sessionStore = new SessionStore();
    const session = await sessionStore.createSession({
      workspaceRoot,
      mode: "execute",
      profile: "execute",
    });
    const tasksDir = path.join(workspaceRoot, ".tasks-shared");

    const ctxA: ToolRuntimeContext = {
      workspaceRoot,
      session,
      sessionStore,
      permissionStore: new PermissionStore(workspaceRoot, session.id),
      taskManager: new TaskManager(tasksDir),
      profile: "execute",
      runId: "run_a",
      emitEvent: async () => {},
      onHumanQuestion: async () => ({ answers: { q1: ["a"] } }),
      onApproval: async () => "allow",
    };

    const launched = await invokeToolByName(
      "Task",
      {
        description: "Background task",
        prompt: "Longer run",
        subagent_type: "worker",
        run_in_background: true,
      },
      ctxA,
    );
    expect(launched.ok).toBe(true);
    if (!launched.ok) {
      return;
    }
    const taskId = (launched.value as { task_id: string }).task_id;

    const ctxB: ToolRuntimeContext = {
      ...ctxA,
      runId: "run_b",
      taskManager: new TaskManager(tasksDir),
    };

    const out = await invokeToolByName(
      "TaskOutput",
      { task_id: taskId, block: false, timeout: 100 },
      ctxB,
    );
    expect(out.ok).toBe(true);
  });

  test("WebSearch returns WEBSEARCH_UNAVAILABLE when provider env missing", async () => {
    process.env.OPENROUTER_API_KEY = "";
    process.env.OPENROUTER_WEBSEARCH_MODEL = "";

    const ctx = await createContext({ mode: "execute" });
    const result = await invokeToolByName("WebSearch", { query: "latest bun release" }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("WEBSEARCH_UNAVAILABLE");
    }
  });

  test("WebFetch stores artifact path when response is truncated", async () => {
    globalThis.fetch = (async () =>
      new Response("x".repeat(READ_LIMITS.maxBytes + 64), {
        status: 200,
      })) as unknown as typeof fetch;

    const ctx = await createContext({ mode: "execute" });
    const result = await invokeToolByName(
      "WebFetch",
      { url: "https://example.com", prompt: "Summarize" },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const out = result.value as { truncated: boolean; artifact_path: string | null };
    expect(out.truncated).toBe(true);
    expect(typeof out.artifact_path).toBe("string");
    expect(await Bun.file(out.artifact_path!).exists()).toBe(true);
  });

  test("Grep supports files_with_matches and count output modes", async () => {
    const ctx = await createContext({ mode: "execute" });
    await Bun.write(path.join(ctx.workspaceRoot, "grep-a.txt"), "alpha\nbeta\nalpha\n");

    const filesOnly = await invokeToolByName(
      "Grep",
      { pattern: "alpha", path: ctx.workspaceRoot, output_mode: "files_with_matches" },
      ctx,
    );
    expect(filesOnly.ok).toBe(true);
    if (filesOnly.ok) {
      const out = filesOnly.value as { entries: Array<{ file_path: string; line: string }> };
      expect(out.entries.length).toBeGreaterThan(0);
      expect(out.entries[0]?.line).toBe("");
    }

    const countMode = await invokeToolByName(
      "Grep",
      { pattern: "alpha", path: ctx.workspaceRoot, output_mode: "count" },
      ctx,
    );
    expect(countMode.ok).toBe(true);
    if (countMode.ok) {
      const out = countMode.value as { entries: Array<{ line: string }> };
      expect(out.entries.length).toBeGreaterThan(0);
    }
  });
});
