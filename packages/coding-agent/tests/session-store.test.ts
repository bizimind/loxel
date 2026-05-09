import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, rm } from "node:fs/promises";
import path from "node:path";

import { SessionStore } from "../src/session/store.ts";
import { getSessionPaths } from "../src/state/layout.ts";

const originalHome = process.env.HOME;
const originalStateRoot = process.env.CODING_AGENT_STATE_ROOT;

function makeTempHome(): string {
  return path.join(
    process.cwd(),
    "tmp-test-home",
    `session-store-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
}

describe("SessionStore", () => {
  let testHome: string;

  beforeEach(() => {
    testHome = makeTempHome();
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
    await rm(path.join(process.cwd(), "tmp-test-workspace"), { recursive: true, force: true });
    process.env.HOME = originalHome;
    process.env.CODING_AGENT_STATE_ROOT = originalStateRoot;
  });

  test("creates and lists session", async () => {
    const store = new SessionStore();
    const session = await store.createSession({
      workspaceRoot: process.cwd(),
      profile: "execute",
      declaredTools: ["Read", "Write"],
    });

    const list = await store.listSessions();
    expect(list.some((item) => item.id === session.id)).toBe(true);
    const loaded = await store.loadSession(session.id);
    expect(loaded.declaredTools).toEqual(["Read", "Write"]);
  });

  test("rejects invalid custom session ids", async () => {
    const store = new SessionStore();
    await expect(
      store.createSession({ workspaceRoot: process.cwd(), sessionId: "../../etc/passwd" }),
    ).rejects.toThrow("Invalid session id");
  });

  test("plan sessions auto-create plan artifact outside workspace", async () => {
    const workspaceRoot = path.join(process.cwd(), "tmp-test-workspace", "plan-session");
    const store = new SessionStore();
    const session = await store.createSession({ workspaceRoot, profile: "plan", mode: "plan" });

    const planPath = session.state.plan.planFilePath;
    expect(typeof planPath).toBe("string");
    expect(planPath?.includes(".local/state/loxel/coding-agent")).toBe(true);
    expect(planPath?.includes("/plans/")).toBe(true);
    expect(planPath?.startsWith(workspaceRoot)).toBe(false);
    expect(await Bun.file(planPath!).exists()).toBe(true);
  });

  test("rewind creates new branch and restores pointer", async () => {
    const store = new SessionStore();
    let session = await store.createSession({ workspaceRoot: process.cwd() });

    const msg1 = await store.appendMessage(session, "user", "hello", "run_1");
    session = await store.loadSession(session.id);
    await store.appendMessage(session, "assistant", "world", "run_1");

    const rewound = await store.rewind(session.id, msg1.id);

    expect(rewound.activeMessageId).toBe(msg1.id);
    expect(rewound.activeBranchId).not.toBe(msg1.branchId);
    expect(rewound.branches[rewound.activeBranchId]?.forkedFromMessageId).toBe(msg1.id);
  });

  test("fork clones full timeline with new session id", async () => {
    const store = new SessionStore();
    let session = await store.createSession({ workspaceRoot: process.cwd() });
    const firstMessage = await store.appendMessage(session, "user", "fork-me", "run_1");
    session = await store.loadSession(session.id);
    const secondMessage = await store.appendMessage(session, "assistant", "still-here", "run_1");
    session = await store.loadSession(session.id);
    session.state.todos = [{ content: "keep", status: "in_progress", activeForm: "Keeping" }];
    await store.setState(session, session.state);

    const forked = await store.fork(session.id, firstMessage.id);

    expect(forked.lineage.parentSessionId).toBe(session.id);
    expect(forked.lineage.forkPointMessageId).toBe(firstMessage.id);
    expect(forked.id).not.toBe(session.id);
    expect(forked.messages[secondMessage.id]).toBeDefined();
    expect(forked.state.todos[0]?.content).toBe("keep");
  });

  test("rewind restores agent-controlled state snapshot", async () => {
    const store = new SessionStore();
    let session = await store.createSession({ workspaceRoot: process.cwd() });

    const msg1 = await store.appendMessage(session, "user", "m1", "run_1");
    session = await store.loadSession(session.id);

    session.state.todos = [{ content: "A", status: "in_progress", activeForm: "Doing A" }];
    session.state.reminders.activeConditions.background_task_active = true;
    await store.setState(session, session.state);

    await store.appendMessage(session, "assistant", "m2", "run_1");
    session = await store.loadSession(session.id);
    session.state.todos = [{ content: "B", status: "in_progress", activeForm: "Doing B" }];
    session.state.reminders.activeConditions.background_task_active = false;
    await store.setState(session, session.state);
    await store.appendMessage(session, "user", "m3", "run_1");

    const rewound = await store.rewind(session.id, msg1.id);
    expect(rewound.state.todos[0]?.content).toBe("A");
    expect(rewound.state.reminders.activeConditions.background_task_active).toBe(true);
  });

  test("compaction replaces active model context but keeps rewindable history", async () => {
    const store = new SessionStore();
    let session = await store.createSession({ workspaceRoot: process.cwd() });
    const m1 = await store.appendMessage(session, "user", "hello", "run_1");
    session = await store.loadSession(session.id);
    const m2 = await store.appendMessage(session, "assistant", "world", "run_1");
    session = await store.loadSession(session.id);
    await store.appendMessage(session, "user", "more", "run_1");

    const compacted = await store.compact(session.id);
    expect(compacted.compactions.length).toBe(1);
    expect(typeof compacted.contextReplacementMessageId).toBe("string");
    expect(compacted.state.reminders.activeConditions.context_compacted).toBe(true);

    const loaded = await store.loadSession(session.id);
    const modelMessages = store.getMessagesForModel(loaded);
    expect(modelMessages.length).toBe(1);
    expect(loaded.contextReplacementMessageId).not.toBeNull();
    expect(modelMessages[0]?.id).toBe(loaded.contextReplacementMessageId ?? undefined);

    const compactionId = compacted.compactions[0]?.id;
    const artifactPath = path.join(
      getSessionPaths(session.id).compactionsDir,
      `${compactionId}.json`,
    );
    expect(await Bun.file(artifactPath).exists()).toBe(true);

    const rewound = await store.rewind(session.id, m2.id);
    expect(rewound.activeMessageId).toBe(m2.id);
    expect(rewound.messages[m1.id]).toBeDefined();
  });

  test("can replay deterministic state from events", async () => {
    const store = new SessionStore();
    let session = await store.createSession({ workspaceRoot: process.cwd(), profile: "execute" });
    await store.appendMessage(session, "user", "one", "run_1");
    session = await store.loadSession(session.id);
    session.state.todos = [{ content: "Replay", status: "in_progress", activeForm: "Replaying" }];
    await store.setState(session, session.state);
    await store.appendMessage(session, "assistant", "two", "run_1");
    session = await store.loadSession(session.id);

    const replayed = await store.replayFromEvents(session.id);
    expect(replayed.activeMessageId).toBe(session.activeMessageId);
    expect(replayed.state.todos[0]?.content).toBe("Replay");
    expect(Object.keys(replayed.messages).length).toBe(2);
  });

  test("serializes concurrent appendMessage operations per session", async () => {
    const store = new SessionStore();
    const session = await store.createSession({ workspaceRoot: process.cwd() });

    const [a, b] = await Promise.all([
      store.appendMessage(session, "user", "a", "run_1"),
      store.appendMessage(session, "assistant", "b", "run_1"),
    ]);

    const loaded = await store.loadSession(session.id);
    const msgA = loaded.messages[a.id];
    const msgB = loaded.messages[b.id];
    expect(msgA).toBeDefined();
    expect(msgB).toBeDefined();

    const roots = [msgA?.parentMessageId, msgB?.parentMessageId].filter(
      (parentId) => parentId === null,
    );
    expect(roots.length).toBe(1);

    const linkedToSibling =
      msgA?.parentMessageId === b.id || msgB?.parentMessageId === a.id || false;
    expect(linkedToSibling).toBe(true);
  });

  test("replay fails on malformed event lines", async () => {
    const store = new SessionStore();
    const session = await store.createSession({ workspaceRoot: process.cwd(), profile: "execute" });
    const paths = getSessionPaths(session.id);

    await appendFile(paths.eventsFile, "{ malformed json line }\n", { encoding: "utf8" });
    await expect(store.loadSession(session.id)).rejects.toThrow("Invalid JSONL line");
  });

  test("listSessions fails when a session cannot be replayed", async () => {
    const store = new SessionStore();
    const session = await store.createSession({ workspaceRoot: process.cwd(), profile: "execute" });
    const paths = getSessionPaths(session.id);

    await appendFile(paths.eventsFile, "{ malformed json line }\n", { encoding: "utf8" });
    await expect(store.listSessions()).rejects.toThrow("Invalid JSONL line");
  });
});
