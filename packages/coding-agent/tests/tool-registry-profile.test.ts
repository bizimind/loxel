import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type { ToolRuntimeContext } from "../src/tools/context.ts";

import { PermissionStore } from "../src/permissions/store.ts";
import { SessionStore } from "../src/session/store.ts";
import { createAiToolSet } from "../src/tools/registry.ts";
import { TaskManager } from "../src/tools/task-manager.ts";

const originalHome = process.env.HOME;
const originalStateRoot = process.env.CODING_AGENT_STATE_ROOT;

describe("tool registry profile exposure", () => {
  let testHome: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    testHome = path.join(process.cwd(), "tmp-test-home", `registry-${Date.now()}`);
    workspaceRoot = path.join(process.cwd(), "tmp-test-workspace", `registry-${Date.now()}`);
    process.env.HOME = testHome;
    process.env.CODING_AGENT_STATE_ROOT = path.join(
      testHome,
      ".local",
      "state",
      "loxel",
      "coding-agent",
    );
    await mkdir(workspaceRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(testHome, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(path.join(process.cwd(), "tmp-test-home"), { recursive: true, force: true });
    await rm(path.join(process.cwd(), "tmp-test-workspace"), { recursive: true, force: true });
    process.env.HOME = originalHome;
    process.env.CODING_AGENT_STATE_ROOT = originalStateRoot;
  });

  async function contextFor(profile: "execute" | "plan" | "minimal"): Promise<ToolRuntimeContext> {
    const store = new SessionStore();
    const session = await store.createSession({
      workspaceRoot,
      profile,
      mode: profile === "plan" ? "plan" : "execute",
    });

    return {
      workspaceRoot,
      session,
      sessionStore: store,
      permissionStore: new PermissionStore(workspaceRoot, session.id),
      taskManager: new TaskManager(path.join(workspaceRoot, ".tasks")),
      profile,
      runId: "run_test",
      emitEvent: async () => {},
      onHumanQuestion: async () => ({ answers: { q1: ["a"] } }),
      onApproval: async () => "allow",
    };
  }

  test("minimal profile omits mutation tools", async () => {
    const ctx = await contextFor("minimal");
    const toolSet = createAiToolSet(ctx);

    expect(toolSet.Read).toBeDefined();
    expect(toolSet.Grep).toBeDefined();
    expect(toolSet.Write).toBeUndefined();
    expect(toolSet.Edit).toBeUndefined();
    expect(toolSet.Bash).toBeUndefined();
  });

  test("plan profile excludes Bash but includes plan transition tools", async () => {
    const ctx = await contextFor("plan");
    const toolSet = createAiToolSet(ctx);

    expect(toolSet.EnterPlanMode).toBeDefined();
    expect(toolSet.ExitPlanMode).toBeDefined();
    expect(toolSet.Bash).toBeUndefined();
  });

  test("declared tools further restrict exposure", async () => {
    const ctx = await contextFor("execute");
    ctx.declaredTools = ["Read", "ToolSearch"];

    const toolSet = createAiToolSet(ctx);
    expect(toolSet.Read).toBeDefined();
    expect(toolSet.ToolSearch).toBeDefined();
    expect(toolSet.Write).toBeUndefined();
    expect(toolSet.Bash).toBeUndefined();
  });
});
