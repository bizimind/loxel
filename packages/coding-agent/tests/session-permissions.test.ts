import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  type TestEnv,
  Session,
  path,
  collectEvents,
  createMockModel,
  patchSessionModel,
  setupTestEnv,
  textStreamParts,
  toolCallStreamParts,
} from "./helpers/mock-session.ts";

describe("Session permissions", () => {
  let env: TestEnv;
  let session: Session | null;

  beforeEach(async () => {
    env = await setupTestEnv("permissions");
    session = null;
  });

  afterEach(async () => {
    session?.destroy();
    session = null;
    await env.cleanup();
  });

  // -------------------------------------------------------------------------
  // Approval flow
  // -------------------------------------------------------------------------

  describe("approval flow", () => {
    test("Write triggers approval.requested, auto-allow proceeds", async () => {
      let approvalCount = 0;
      const events = collectEvents({
        "approval.requested": (e) => {
          approvalCount++;
          setTimeout(() => e.respond("allow"), 50);
        },
      });

      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      const targetPath = path.join(env.workspaceRoot, "approved-write.txt");
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Write", { file_path: targetPath, content: "ok" }),
          textStreamParts("Done"),
        ]),
      );

      await session.send("write a file");

      expect(approvalCount).toBeGreaterThan(0);
      expect(await Bun.file(targetPath).text()).toBe("ok");
    });

    test("deny decision prevents file creation", async () => {
      const events = collectEvents({
        "approval.requested": (e) => {
          setTimeout(() => e.respond("deny"), 50);
        },
      });

      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      const targetPath = path.join(env.workspaceRoot, "denied-write.txt");
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Write", { file_path: targetPath, content: "no" }),
          textStreamParts("Write was denied"),
        ]),
      );

      await session.send("write a file");

      expect(await Bun.file(targetPath).exists()).toBe(false);
    });

    test("allow_this_session skips approval on subsequent calls", async () => {
      let approvalCount = 0;
      const events = collectEvents({
        "approval.requested": (e) => {
          approvalCount++;
          setTimeout(() => e.respond("allow_this_session"), 50);
        },
      });

      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      const file1 = path.join(env.workspaceRoot, "session-file1.txt");
      const file2 = path.join(env.workspaceRoot, "session-file2.txt");
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Write", { file_path: file1, content: "one" }),
          toolCallStreamParts("Write", { file_path: file2, content: "two" }),
          textStreamParts("Both written"),
        ]),
      );

      await session.send("write two files");

      expect(await Bun.file(file1).text()).toBe("one");
      expect(await Bun.file(file2).text()).toBe("two");
      // Approval should only be asked once (second Write reuses cached permission)
      expect(approvalCount).toBe(1);
    });

    test("approvalOverrides allow bypasses callback", async () => {
      let approvalCalled = false;
      const events = collectEvents({
        "approval.requested": (e) => {
          approvalCalled = true;
          setTimeout(() => e.respond("allow"), 50);
        },
      });

      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      const targetPath = path.join(env.workspaceRoot, "override.txt");
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Write", { file_path: targetPath, content: "overridden" }),
          textStreamParts("Written"),
        ]),
      );

      await session.send("write", { approvalOverrides: { Write: "allow" } });

      expect(approvalCalled).toBe(false);
      expect(await Bun.file(targetPath).text()).toBe("overridden");
    });

    test("approvalOverrides deny prevents tool without callback", async () => {
      let approvalCalled = false;
      const events = collectEvents({
        "approval.requested": (e) => {
          approvalCalled = true;
          setTimeout(() => e.respond("allow"), 50);
        },
      });

      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      const targetPath = path.join(env.workspaceRoot, "denied-override.txt");
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Write", { file_path: targetPath, content: "nope" }),
          textStreamParts("Write was denied by override"),
        ]),
      );

      await session.send("write", { approvalOverrides: { Write: "deny" } });

      expect(approvalCalled).toBe(false);
      expect(await Bun.file(targetPath).exists()).toBe(false);
    });

    test("approval for tool not in overrides still triggers callback", async () => {
      let approvalCount = 0;
      const events = collectEvents({
        "approval.requested": (e) => {
          approvalCount++;
          setTimeout(() => e.respond("allow"), 50);
        },
      });

      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Write", {
            file_path: path.join(env.workspaceRoot, "write-ok.txt"),
            content: "ok",
          }),
          toolCallStreamParts("Bash", { command: "echo hello" }),
          textStreamParts("Done"),
        ]),
      );

      await session.send("write then bash", { approvalOverrides: { Write: "allow" } });

      // Only Bash should trigger approval (Write was overridden)
      expect(approvalCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Permission persistence
  // -------------------------------------------------------------------------

  describe("permission persistence", () => {
    test("allow_always persists across sessions", async () => {
      let approvalCount = 0;
      const events = collectEvents({
        "approval.requested": (e) => {
          approvalCount++;
          setTimeout(() => e.respond("allow_always"), 50);
        },
      });

      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      const file1 = path.join(env.workspaceRoot, "perm1.txt");
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Write", { file_path: file1, content: "first" }),
          textStreamParts("Done"),
        ]),
      );
      await session.send("write file");

      expect(approvalCount).toBe(1);
      session.destroy();

      // Second session — allow_always should persist
      let secondApprovalCount = 0;
      const events2 = collectEvents({
        "approval.requested": (e) => {
          secondApprovalCount++;
          setTimeout(() => e.respond("allow"), 50);
        },
      });
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events2.handlers,
      });
      const file2 = path.join(env.workspaceRoot, "perm2.txt");
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Write", { file_path: file2, content: "second" }),
          textStreamParts("Done again"),
        ]),
      );
      await session.send("write another file");

      expect(secondApprovalCount).toBe(0);
      expect(await Bun.file(file2).text()).toBe("second");
    });

    test("allow_this_session does NOT persist to new session", async () => {
      let approvalCount = 0;
      const events = collectEvents({
        "approval.requested": (e) => {
          approvalCount++;
          setTimeout(() => e.respond("allow_this_session"), 50);
        },
      });

      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      const file1 = path.join(env.workspaceRoot, "session-perm1.txt");
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Write", { file_path: file1, content: "first" }),
          textStreamParts("Done"),
        ]),
      );
      await session.send("write file");

      expect(approvalCount).toBe(1);
      session.destroy();

      // Second session — allow_this_session should NOT persist
      let secondApprovalCount = 0;
      const events2 = collectEvents({
        "approval.requested": (e) => {
          secondApprovalCount++;
          setTimeout(() => e.respond("allow"), 50);
        },
      });
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events2.handlers,
      });
      const file2 = path.join(env.workspaceRoot, "session-perm2.txt");
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Write", { file_path: file2, content: "second" }),
          textStreamParts("Done again"),
        ]),
      );
      await session.send("write another file");

      // Approval IS requested again in the new session
      expect(secondApprovalCount).toBe(1);
    });

    test("Edit and Write share FileWrite fingerprint", async () => {
      let approvalCount = 0;
      const events = collectEvents({
        "approval.requested": (e) => {
          approvalCount++;
          setTimeout(() => e.respond("allow_this_session"), 50);
        },
      });

      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      const filePath = path.join(env.workspaceRoot, "shared-fp.txt");
      await Bun.write(filePath, "old text");
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Edit", {
            file_path: filePath,
            old_string: "old text",
            new_string: "new text",
          }),
          toolCallStreamParts("Write", {
            file_path: path.join(env.workspaceRoot, "shared-fp2.txt"),
            content: "written",
          }),
          textStreamParts("Both done"),
        ]),
      );

      await session.send("edit then write");

      // Write should NOT trigger a new approval (FileWrite unified fingerprint)
      expect(approvalCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Destroy during pending approval/question
  // -------------------------------------------------------------------------

  describe("destroy during pending operations", () => {
    test("destroy during pending approval rejects send()", async () => {
      const approvalRequested = Promise.withResolvers<void>();
      const events = collectEvents({
        "approval.requested": (e) => {
          // Push event but do NOT respond — leave it pending
          events.all.push(e);
          approvalRequested.resolve();
        },
      });

      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      const targetPath = path.join(env.workspaceRoot, "pending-approval.txt");
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Write", { file_path: targetPath, content: "pending" }),
          textStreamParts("unreachable"),
        ]),
      );

      const pending = session.send("write a file");
      await approvalRequested.promise;
      session.destroy();

      await expect(pending).rejects.toThrow("Session destroyed");
      session = null;
    });

    test("destroy during pending human input rejects send()", async () => {
      const humanInputRequested = Promise.withResolvers<void>();
      const events = collectEvents({
        "human.input.requested": (e) => {
          // Push event but do NOT respond — leave it pending
          events.all.push(e);
          humanInputRequested.resolve();
        },
      });

      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("AskUserQuestion", {
            questions: [
              {
                id: "q1",
                question: "Pick one?",
                header: "Choice",
                options: [
                  { label: "A (Recommended)", description: "First choice" },
                  { label: "B", description: "Second choice" },
                ],
              },
            ],
          }),
          textStreamParts("unreachable"),
        ]),
      );

      const pending = session.send("ask something");
      await humanInputRequested.promise;
      session.destroy();

      await expect(pending).rejects.toThrow("Session destroyed");
      session = null;
    });
  });
});
