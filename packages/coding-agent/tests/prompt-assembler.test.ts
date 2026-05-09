import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";

import { buildPromptAssembly } from "../src/prompts/assembler.ts";
import { markReminderInjected } from "../src/prompts/reminders.ts";
import { SessionStore } from "../src/session/store.ts";

const originalHome = process.env.HOME;
const originalStateRoot = process.env.CODING_AGENT_STATE_ROOT;

describe("PromptAssembler", () => {
  let testHome: string;

  beforeEach(() => {
    testHome = path.join(process.cwd(), "tmp-test-home", `prompt-${Date.now()}`);
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
    await rm(path.join(process.cwd(), "tmp-test-home"), { recursive: true, force: true });
    process.env.HOME = originalHome;
    process.env.CODING_AGENT_STATE_ROOT = originalStateRoot;
  });

  test("injects background task reminder based on active condition", async () => {
    const store = new SessionStore();
    const session = await store.createSession({ workspaceRoot: process.cwd() });
    session.state.reminders.activeConditions.background_task_active = true;
    session.state.reminders.cooldowns.background_task_active = 1;

    const assembly = buildPromptAssembly({
      session,
      dateIso: "2026-02-17",
      activeToolReminders: [],
    });

    expect(
      assembly.ephemeralReminderSegments.some(
        (segment) => segment.id === "reminder.background_task_active",
      ),
    ).toBe(true);
  });

  test("respects cooldown after reminder injection", async () => {
    const store = new SessionStore();
    const session = await store.createSession({ workspaceRoot: process.cwd() });
    session.state.reminders.activeConditions.background_task_active = true;
    session.state.reminders.cooldowns.background_task_active = 1;

    const first = buildPromptAssembly({ session, dateIso: "2026-02-17", activeToolReminders: [] });
    expect(first.ephemeralReminderSegments.length).toBeGreaterThan(0);

    markReminderInjected(session, "background_task_active");

    const second = buildPromptAssembly({ session, dateIso: "2026-02-17", activeToolReminders: [] });

    expect(
      second.ephemeralReminderSegments.some(
        (segment) => segment.id === "reminder.background_task_active",
      ),
    ).toBe(false);
  });

  test("injects permission denied reminder only once by default", async () => {
    const store = new SessionStore();
    const session = await store.createSession({ workspaceRoot: process.cwd() });
    session.state.reminders.activeConditions.permission_denied = true;
    session.state.reminders.cooldowns.permission_denied = 1;
    session.state.reminders.maxRepeats.permission_denied = 1;

    const first = buildPromptAssembly({ session, dateIso: "2026-02-17", activeToolReminders: [] });
    expect(
      first.ephemeralReminderSegments.some(
        (segment) => segment.id === "reminder.permission_denied",
      ),
    ).toBe(true);

    markReminderInjected(session, "permission_denied");
    const second = buildPromptAssembly({ session, dateIso: "2026-02-17", activeToolReminders: [] });
    expect(
      second.ephemeralReminderSegments.some(
        (segment) => segment.id === "reminder.permission_denied",
      ),
    ).toBe(false);
  });

  test("assembly metadata includes deterministic cache key", async () => {
    const store = new SessionStore();
    const session = await store.createSession({ workspaceRoot: process.cwd() });

    const a = buildPromptAssembly({ session, dateIso: "2026-02-17", activeToolReminders: [] });
    const b = buildPromptAssembly({ session, dateIso: "2026-02-17", activeToolReminders: [] });
    expect(a.metadata.cacheKey).toBe(b.metadata.cacheKey);
    expect(a.metadata.cacheKey.length).toBeGreaterThan(10);
  });

  test("injects capability fallback reminder when declared tools are provided", async () => {
    const store = new SessionStore();
    const session = await store.createSession({
      workspaceRoot: process.cwd(),
      declaredTools: ["Read", "ToolSearch"],
    });

    const assembly = buildPromptAssembly({
      session,
      dateIso: "2026-02-17",
      activeToolReminders: [],
    });
    expect(
      assembly.ephemeralReminderSegments.some((segment) =>
        segment.id.startsWith("reminder.capability_"),
      ),
    ).toBe(true);
  });
});
