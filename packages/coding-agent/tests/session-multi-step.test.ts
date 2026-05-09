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

describe("Session multi-step and multi-message", () => {
  let env: TestEnv;
  let session: Session | null;

  beforeEach(async () => {
    env = await setupTestEnv("multi-step");
    session = null;
  });

  afterEach(async () => {
    session?.destroy();
    session = null;
    await env.cleanup();
  });

  // -------------------------------------------------------------------------
  // Multi-step tool chains
  // -------------------------------------------------------------------------

  describe("multi-step tool chains", () => {
    test("Read then Write sequence", async () => {
      const inputFile = path.join(env.workspaceRoot, "input.txt");
      const outputFile = path.join(env.workspaceRoot, "output.txt");
      await Bun.write(inputFile, "original content");

      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Read", { file_path: inputFile }),
          toolCallStreamParts("Write", { file_path: outputFile, content: "transformed content" }),
          textStreamParts("Done reading and writing"),
        ]),
      );

      const result = await session.send("copy and modify the file");

      expect(result.text).toContain("Done reading and writing");

      const toolRequested = events.ofType("tool.call.requested");
      expect(toolRequested.length).toBe(2);
      expect(toolRequested[0]!.toolName).toBe("Read");
      expect(toolRequested[1]!.toolName).toBe("Write");

      const toolResults = events.ofType("tool.call.result");
      expect(toolResults.length).toBe(2);

      expect(await Bun.file(inputFile).exists()).toBe(true);
      expect(await Bun.file(outputFile).text()).toBe("transformed content");
    });

    test("Glob then Read then Edit chain", async () => {
      const filePath = path.join(env.workspaceRoot, "target.ts");
      await Bun.write(filePath, "const old = true;");

      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Glob", { pattern: "*.ts", path: env.workspaceRoot }),
          toolCallStreamParts("Read", { file_path: filePath }),
          toolCallStreamParts("Edit", {
            file_path: filePath,
            old_string: "const old = true;",
            new_string: "const updated = true;",
          }),
          textStreamParts("File has been updated"),
        ]),
      );

      const result = await session.send("find, read, and edit the ts file");

      expect(result.text).toContain("File has been updated");

      const toolRequested = events.ofType("tool.call.requested");
      expect(toolRequested.length).toBe(3);
      expect(toolRequested[0]!.toolName).toBe("Glob");
      expect(toolRequested[1]!.toolName).toBe("Read");
      expect(toolRequested[2]!.toolName).toBe("Edit");

      expect(await Bun.file(filePath).text()).toBe("const updated = true;");
    });

    test("Bash output flows to next model step", async () => {
      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Bash", { command: "echo test-output" }),
          textStreamParts("Command completed successfully"),
        ]),
      );

      const result = await session.send("run echo");

      expect(result.text).toContain("Command completed successfully");

      const toolResults = events.ofType("tool.call.result");
      expect(toolResults.length).toBe(1);
      expect(toolResults[0]!.isError).toBe(false);

      expect(events.ofType("run.completed").length).toBe(1);
    });

    test("Three tool calls: Glob, Read, Write", async () => {
      const srcFile = path.join(env.workspaceRoot, "source.txt");
      const destFile = path.join(env.workspaceRoot, "dest.txt");
      await Bun.write(srcFile, "source data");

      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Glob", { pattern: "source.*", path: env.workspaceRoot }),
          toolCallStreamParts("Read", { file_path: srcFile }),
          toolCallStreamParts("Write", { file_path: destFile, content: "copied data" }),
          textStreamParts("All three steps done"),
        ]),
      );

      const result = await session.send("glob, read, and write");

      expect(result.text).toContain("All three steps done");

      const toolResults = events.ofType("tool.call.result");
      expect(toolResults.length).toBe(3);
      expect(toolResults.every((r) => !r.isError)).toBe(true);

      expect(await Bun.file(destFile).text()).toBe("copied data");
    });
  });

  // -------------------------------------------------------------------------
  // Multi-message conversations
  // -------------------------------------------------------------------------

  describe("multi-message conversations", () => {
    test("two sequential sends succeed", async () => {
      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([textStreamParts("First response"), textStreamParts("Second response")]),
      );

      const r1 = await session.send("message one");
      const r2 = await session.send("message two");

      expect(r1.text).toContain("First response");
      expect(r2.text).toContain("Second response");
      expect(r1.text).not.toBe(r2.text);
    });

    test("message.received parent chain across sends", async () => {
      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([textStreamParts("first reply"), textStreamParts("second reply")]),
      );

      await session.send("first");
      await session.send("second");

      const received = events.ofType("message.received");
      // Should have user messages from both sends
      expect(received.length).toBeGreaterThanOrEqual(2);

      // Second user message should have a non-null parentMessageId
      const userMessages = received.filter((e) => e.role === "user");
      expect(userMessages.length).toBeGreaterThanOrEqual(2);
      const secondUserMsg = userMessages[1]!;
      expect(secondUserMsg.parentMessageId).not.toBeNull();
    });

    test("tool state persists across sends: Write then Read", async () => {
      const filePath = path.join(env.workspaceRoot, "cross-send.txt");
      const fileContent = "persisted across sends";

      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          // First send: Write the file
          toolCallStreamParts("Write", { file_path: filePath, content: fileContent }),
          textStreamParts("File written"),
          // Second send: Read it back
          toolCallStreamParts("Read", { file_path: filePath }),
          textStreamParts("File read back"),
        ]),
      );

      const r1 = await session.send("write a file");
      expect(r1.text).toContain("File written");

      const r2 = await session.send("read it back");
      expect(r2.text).toContain("File read back");

      // Verify Write and Read both succeeded
      const toolResults = events.ofType("tool.call.result");
      expect(toolResults.length).toBe(2);
      expect(toolResults.every((r) => !r.isError)).toBe(true);

      // Verify the file exists with the written content
      expect(await Bun.file(filePath).text()).toBe(fileContent);
    });

    test("context accumulates across three sends", async () => {
      const globTarget = path.join(env.workspaceRoot, "accumulate.ts");
      const readTarget = path.join(env.workspaceRoot, "accumulate.ts");
      const writeTarget = path.join(env.workspaceRoot, "accumulated-output.txt");
      await Bun.write(globTarget, "export const val = 1;");

      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          // Send 1: Glob
          toolCallStreamParts("Glob", { pattern: "*.ts", path: env.workspaceRoot }),
          textStreamParts("Found files"),
          // Send 2: Read
          toolCallStreamParts("Read", { file_path: readTarget }),
          textStreamParts("Read the file"),
          // Send 3: Write
          toolCallStreamParts("Write", { file_path: writeTarget, content: "accumulated" }),
          textStreamParts("Wrote the output"),
        ]),
      );

      await session.send("find files");
      await session.send("read the found file");
      await session.send("write the output");

      // 3 run.completed events
      expect(events.ofType("run.completed").length).toBe(3);

      // 3 tool.call.requested + 3 tool.call.result = 6 tool events total
      const toolRequested = events.ofType("tool.call.requested");
      const toolResults = events.ofType("tool.call.result");
      expect(toolRequested.length).toBe(3);
      expect(toolResults.length).toBe(3);

      // Verify parent chain is unbroken across all sends
      const received = events.ofType("message.received");
      const userMessages = received.filter((e) => e.role === "user");
      expect(userMessages.length).toBeGreaterThanOrEqual(3);

      // Second and third user messages should have non-null parentMessageId
      expect(userMessages[1]!.parentMessageId).not.toBeNull();
      expect(userMessages[2]!.parentMessageId).not.toBeNull();
    });

    test("approval override in second send does not leak to first", async () => {
      let approvalCount = 0;
      const events = collectEvents({
        "approval.requested": (e) => {
          approvalCount += 1;
          setTimeout(() => e.respond("allow"), 50);
        },
      });

      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      const file1 = path.join(env.workspaceRoot, "first-write.txt");
      const file2 = path.join(env.workspaceRoot, "second-write.txt");
      patchSessionModel(
        session,
        createMockModel([
          // First send: Write without override — approval handler is invoked
          toolCallStreamParts("Write", { file_path: file1, content: "first" }),
          textStreamParts("First write done"),
          // Second send: Write with override — approval handler should NOT be invoked
          toolCallStreamParts("Write", { file_path: file2, content: "second" }),
          textStreamParts("Second write done"),
        ]),
      );

      // First send: no approvalOverrides
      await session.send("write first file");
      expect(approvalCount).toBe(1);

      // Second send: with approvalOverrides for Write
      await session.send("write second file", { approvalOverrides: { Write: "allow" } });

      // Approval was requested exactly once (only during the first send)
      expect(approvalCount).toBe(1);

      // Both files should exist
      expect(await Bun.file(file1).text()).toBe("first");
      expect(await Bun.file(file2).text()).toBe("second");
    });
  });
});
