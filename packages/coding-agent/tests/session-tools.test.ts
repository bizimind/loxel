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

describe("Session tools", () => {
  let env: TestEnv;
  let session: Session | null;

  beforeEach(async () => {
    env = await setupTestEnv("tools");
    session = null;
  });

  afterEach(async () => {
    session?.destroy();
    session = null;
    await env.cleanup();
  });

  // -------------------------------------------------------------------------
  // Basic tool calls
  // -------------------------------------------------------------------------

  describe("basic tool calls", () => {
    test("Read tool reads file content", async () => {
      const filePath = path.join(env.workspaceRoot, "test.txt");
      await Bun.write(filePath, "hello world\nsecond line");

      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Read", { file_path: filePath }),
          textStreamParts("I read the file"),
        ]),
      );

      const result = await session.send("read the file");

      expect(result.text).toContain("I read the file");
      const toolResults = events.ofType("tool.call.result");
      expect(toolResults.length).toBe(1);
      expect(toolResults[0]!.isError).toBe(false);
    });

    test("Write tool creates file on disk", async () => {
      const targetPath = path.join(env.workspaceRoot, "output.txt");

      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Write", { file_path: targetPath, content: "written content" }),
          textStreamParts("File created"),
        ]),
      );

      await session.send("write a file");

      expect(await Bun.file(targetPath).text()).toBe("written content");
    });

    test("Edit tool modifies existing file", async () => {
      const filePath = path.join(env.workspaceRoot, "edit-target.txt");
      await Bun.write(filePath, "old text here");

      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Edit", {
            file_path: filePath,
            old_string: "old text",
            new_string: "new text",
          }),
          textStreamParts("Edited"),
        ]),
      );

      await session.send("edit the file");

      expect(await Bun.file(filePath).text()).toBe("new text here");
    });

    test("Glob finds files by pattern", async () => {
      await Bun.write(path.join(env.workspaceRoot, "a.ts"), "a");
      await Bun.write(path.join(env.workspaceRoot, "b.ts"), "b");
      await Bun.write(path.join(env.workspaceRoot, "c.js"), "c");

      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Glob", { pattern: "*.ts", path: env.workspaceRoot }),
          textStreamParts("Found files"),
        ]),
      );

      await session.send("find ts files");

      const toolResults = events.ofType("tool.call.result");
      expect(toolResults.length).toBe(1);
      expect(toolResults[0]!.isError).toBe(false);
    });

    test("Grep searches file content", async () => {
      await Bun.write(path.join(env.workspaceRoot, "search.txt"), "needle in haystack\njust hay");

      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Grep", { pattern: "needle", path: env.workspaceRoot }),
          textStreamParts("Found it"),
        ]),
      );

      await session.send("search for needle");

      const toolResults = events.ofType("tool.call.result");
      expect(toolResults.length).toBe(1);
      expect(toolResults[0]!.isError).toBe(false);
    });

    test("Bash executes safe command", async () => {
      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Bash", { command: "echo hello-test" }),
          textStreamParts("Command executed"),
        ]),
      );

      await session.send("run echo");

      const toolResults = events.ofType("tool.call.result");
      expect(toolResults.length).toBe(1);
      expect(toolResults[0]!.isError).toBe(false);
    });

    test("TodoWrite + TodoRead roundtrip", async () => {
      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("TodoWrite", {
            todos: [
              { content: "First task", status: "in_progress" },
              { content: "Second task", status: "pending" },
            ],
          }),
          toolCallStreamParts("TodoRead", {}),
          textStreamParts("Tasks managed"),
        ]),
      );

      const result = await session.send("manage todos");

      expect(result.text).toContain("Tasks managed");
      const toolRequested = events.ofType("tool.call.requested");
      expect(toolRequested.some((e) => e.toolName === "TodoWrite")).toBe(true);
      expect(toolRequested.some((e) => e.toolName === "TodoRead")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tool validation errors
  //
  // Current behavior: when a tool handler returns err() (policy violation,
  // validation failure), the AI SDK's execute function throws. The SDK
  // converts this to an internal tool-error and calls the model again with
  // the error context. However, the orchestrator's onStepFinish only
  // processes successful tool-results, so no tool.call.result event is
  // emitted for errors. The tool.call.requested event IS emitted because
  // it's triggered by the raw model stream chunk.
  //
  // These tests verify the model recovers from tool errors and the session
  // completes. The tool.call.requested event confirms the tool was attempted.
  // -------------------------------------------------------------------------

  describe("tool validation errors", () => {
    test("Read with path outside workspace recovers gracefully", async () => {
      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Read", { file_path: "/etc/hosts" }),
          textStreamParts("Recovered from error"),
        ]),
      );

      const result = await session.send("read /etc/hosts");

      expect(result.text).toContain("Recovered from error");
      // tool.call.requested is emitted from the raw model stream
      const toolRequested = events.ofType("tool.call.requested");
      expect(toolRequested.length).toBe(1);
      expect(toolRequested[0]!.toolName).toBe("Read");
      // Session completes despite the tool error
      expect(events.ofType("run.completed").length).toBe(1);
    });

    test("Edit with unrecognized extra field recovers gracefully", async () => {
      const filePath = path.join(env.workspaceRoot, "strict.txt");
      await Bun.write(filePath, "x");

      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Edit", {
            file_path: filePath,
            old_string: "x",
            new_string: "y",
            bogus: true,
          }),
          textStreamParts("Recovered"),
        ]),
      );

      const result = await session.send("edit with bogus field");

      expect(result.text).toContain("Recovered");
      const toolRequested = events.ofType("tool.call.requested");
      expect(toolRequested.length).toBe(1);
      expect(toolRequested[0]!.toolName).toBe("Edit");
      // File should be unchanged since the edit was rejected
      expect(await Bun.file(filePath).text()).toBe("x");
      expect(events.ofType("run.completed").length).toBe(1);
    });

    test("Bash with empty command recovers gracefully", async () => {
      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Bash", { command: "" }),
          textStreamParts("Recovered from empty command"),
        ]),
      );

      const result = await session.send("run empty command");

      expect(result.text).toContain("Recovered from empty command");
      const toolRequested = events.ofType("tool.call.requested");
      expect(toolRequested.length).toBe(1);
      expect(toolRequested[0]!.toolName).toBe("Bash");
      expect(events.ofType("run.completed").length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Write override behavior (EXPECTED -- not yet implemented)
  // -------------------------------------------------------------------------

  describe("Write override behavior", () => {
    test("Write to existing file without override flag is rejected", async () => {
      const filePath = path.join(env.workspaceRoot, "existing.txt");
      await Bun.write(filePath, "original content");

      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Write", { file_path: filePath, content: "overwrite attempt" }),
          textStreamParts("Handled rejection"),
        ]),
      );

      await session.send("write without override");

      const toolResults = events.ofType("tool.call.result");
      expect(toolResults.length).toBe(1);
      expect(toolResults[0]!.isError).toBe(true);
      expect(await Bun.file(filePath).text()).toBe("original content");
    });

    test("Write to existing file with override: true succeeds", async () => {
      const filePath = path.join(env.workspaceRoot, "existing-override.txt");
      await Bun.write(filePath, "original content");

      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Write", {
            file_path: filePath,
            content: "new content",
            override: true,
          }),
          textStreamParts("Override succeeded"),
        ]),
      );

      await session.send("write with override");

      expect(await Bun.file(filePath).text()).toBe("new content");
    });

    test("Write to new file does not require override flag", async () => {
      const filePath = path.join(env.workspaceRoot, "brand-new.txt");

      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Write", { file_path: filePath, content: "fresh content" }),
          textStreamParts("Created new file"),
        ]),
      );

      await session.send("write new file");

      expect(await Bun.file(filePath).text()).toBe("fresh content");
      const toolResults = events.ofType("tool.call.result");
      expect(toolResults.length).toBe(1);
      expect(toolResults[0]!.isError).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Edit interaction patterns
  // -------------------------------------------------------------------------

  describe("Edit interaction patterns", () => {
    test("Edit where old_string not found recovers gracefully", async () => {
      const filePath = path.join(env.workspaceRoot, "no-match.txt");
      await Bun.write(filePath, "actual content here");

      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Edit", {
            file_path: filePath,
            old_string: "nonexistent string",
            new_string: "replacement",
          }),
          textStreamParts("Edit failed gracefully"),
        ]),
      );

      const result = await session.send("edit with bad old_string");

      expect(result.text).toContain("Edit failed gracefully");
      const toolRequested = events.ofType("tool.call.requested");
      expect(toolRequested.length).toBe(1);
      expect(toolRequested[0]!.toolName).toBe("Edit");
      // File should be unchanged
      expect(await Bun.file(filePath).text()).toBe("actual content here");
      expect(events.ofType("run.completed").length).toBe(1);
    });

    test("Edit with replace_all replaces all occurrences", async () => {
      const filePath = path.join(env.workspaceRoot, "replace-all.txt");
      await Bun.write(filePath, "aaa");

      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Edit", {
            file_path: filePath,
            old_string: "a",
            new_string: "b",
            replace_all: true,
          }),
          textStreamParts("Replaced all"),
        ]),
      );

      await session.send("replace all a with b");

      expect(await Bun.file(filePath).text()).toBe("bbb");
    });
  });

  // -------------------------------------------------------------------------
  // Profile-based tool filtering
  //
  // When a tool is excluded by profile or declaredTools, it's not registered
  // in the AI SDK toolset. The model still generates a tool-call stream
  // chunk (which emits tool.call.requested), but the AI SDK skips execution
  // since no matching tool is registered.
  //
  // For "plan" profile: Bash is excluded from the PLAN_SET but IS registered
  // in the toolset (it's in PLAN_SET). However, the handler checks mode and
  // rejects Bash in plan mode, throwing an error through the execute path.
  //
  // For "minimal" profile: Write/Edit/Bash are not in MINIMAL_SET at all,
  // so they're not registered in the toolset.
  // -------------------------------------------------------------------------

  describe("profile-based tool filtering", () => {
    test("plan profile rejects Bash via mode check", async () => {
      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
        profile: "plan",
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Bash", { command: "echo should-fail" }),
          textStreamParts("Bash was rejected"),
        ]),
      );

      const result = await session.send("run bash in plan mode");

      expect(result.text).toContain("Bash was rejected");
      // tool.call.requested is emitted from the raw model stream
      const toolRequested = events.ofType("tool.call.requested");
      expect(toolRequested.some((e) => e.toolName === "Bash")).toBe(true);
      expect(events.ofType("run.completed").length).toBe(1);
    });

    test("minimal profile excludes Write from toolset", async () => {
      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
        profile: "minimal",
      });
      const targetPath = path.join(env.workspaceRoot, "minimal-write.txt");
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Write", { file_path: targetPath, content: "should fail" }),
          textStreamParts("Write was rejected"),
        ]),
      );

      const result = await session.send("write in minimal mode");

      expect(result.text).toContain("Write was rejected");
      // tool.call.requested is still emitted (from model stream)
      const toolRequested = events.ofType("tool.call.requested");
      expect(toolRequested.some((e) => e.toolName === "Write")).toBe(true);
      // File should not exist
      expect(await Bun.file(targetPath).exists()).toBe(false);
    });

    test("minimal profile allows Read, Glob, Grep", async () => {
      const filePath = path.join(env.workspaceRoot, "minimal-read.txt");
      await Bun.write(filePath, "minimal content");

      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
        profile: "minimal",
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Read", { file_path: filePath }),
          toolCallStreamParts("Glob", { pattern: "*.txt", path: env.workspaceRoot }),
          toolCallStreamParts("Grep", { pattern: "minimal", path: env.workspaceRoot }),
          textStreamParts("All three tools worked"),
        ]),
      );

      const result = await session.send("read glob grep in minimal");

      expect(result.text).toContain("All three tools worked");
      const toolResults = events.ofType("tool.call.result");
      expect(toolResults.length).toBe(3);
      expect(toolResults.every((r) => !r.isError)).toBe(true);
    });

    test("declaredTools restricts available tools", async () => {
      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
        declaredTools: ["Read", "Glob"],
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Grep", { pattern: "test", path: env.workspaceRoot }),
          textStreamParts("Grep was rejected"),
        ]),
      );

      const result = await session.send("grep with restricted tools");

      expect(result.text).toContain("Grep was rejected");
      // tool.call.requested is still emitted from the model stream
      const toolRequested = events.ofType("tool.call.requested");
      expect(toolRequested.some((e) => e.toolName === "Grep")).toBe(true);
      // No successful tool.call.result since Grep wasn't in toolset
      const toolResults = events.ofType("tool.call.result");
      expect(toolResults.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Error recovery
  // -------------------------------------------------------------------------

  describe("error recovery", () => {
    test("tool error does not abort the run", async () => {
      const nonexistentPath = path.join(env.workspaceRoot, "does-not-exist.txt");

      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Read", { file_path: nonexistentPath }),
          textStreamParts("Recovered from missing file"),
        ]),
      );

      const result = await session.send("read nonexistent file");

      expect(result.text).toContain("Recovered from missing file");
      // tool.call.requested confirms the Read was attempted
      const toolRequested = events.ofType("tool.call.requested");
      expect(toolRequested.length).toBe(1);
      expect(toolRequested[0]!.toolName).toBe("Read");
      // Session completes despite the tool error
      expect(events.ofType("run.completed").length).toBe(1);
    });

    test("multiple tool errors followed by success", async () => {
      const missing1 = path.join(env.workspaceRoot, "missing1.txt");
      const missing2 = path.join(env.workspaceRoot, "missing2.txt");
      const existing = path.join(env.workspaceRoot, "existing.txt");
      await Bun.write(existing, "real content");

      const events = collectEvents();
      session = await Session.create({
        workspaceRoot: env.workspaceRoot,
        handlers: events.handlers,
      });
      patchSessionModel(
        session,
        createMockModel([
          toolCallStreamParts("Read", { file_path: missing1 }),
          toolCallStreamParts("Read", { file_path: missing2 }),
          toolCallStreamParts("Read", { file_path: existing }),
          textStreamParts("Finally succeeded"),
        ]),
      );

      const result = await session.send("read multiple files");

      expect(result.text).toContain("Finally succeeded");
      // All three Read calls were attempted
      const toolRequested = events.ofType("tool.call.requested");
      expect(toolRequested.filter((e) => e.toolName === "Read").length).toBe(3);
      // Only the successful Read produces a tool.call.result
      const toolResults = events.ofType("tool.call.result");
      expect(toolResults.length).toBe(1);
      expect(toolResults[0]!.isError).toBe(false);
      expect(events.ofType("run.completed").length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // WebFetch with mocked fetch
  // -------------------------------------------------------------------------

  describe("WebFetch", () => {
    test("WebFetch returns content with mocked globalThis.fetch", async () => {
      const originalFetch = globalThis.fetch;
      try {
        const mockFetch = async () =>
          new Response("page content", { status: 200, headers: { "content-type": "text/html" } });
        Object.assign(globalThis, { fetch: mockFetch });

        const events = collectEvents();
        session = await Session.create({
          workspaceRoot: env.workspaceRoot,
          handlers: events.handlers,
        });
        patchSessionModel(
          session,
          createMockModel([
            toolCallStreamParts("WebFetch", {
              url: "https://example.com/page",
              prompt: "summarize",
            }),
            textStreamParts("Fetched the page"),
          ]),
        );

        const result = await session.send("fetch a page");

        expect(result.text).toContain("Fetched the page");
        const toolResults = events.ofType("tool.call.result");
        expect(toolResults.length).toBe(1);
        expect(toolResults[0]!.isError).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // -------------------------------------------------------------------------
  // WebSearch
  // -------------------------------------------------------------------------

  describe("WebSearch", () => {
    test("WebSearch with missing provider config recovers gracefully", async () => {
      const originalApiKey = process.env.OPENROUTER_API_KEY;
      const originalModel = process.env.OPENROUTER_WEBSEARCH_MODEL;
      try {
        delete process.env.OPENROUTER_API_KEY;
        delete process.env.OPENROUTER_WEBSEARCH_MODEL;

        const events = collectEvents();
        session = await Session.create({
          workspaceRoot: env.workspaceRoot,
          handlers: events.handlers,
        });
        patchSessionModel(
          session,
          createMockModel([
            toolCallStreamParts("WebSearch", { query: "test query" }),
            textStreamParts("Search was unavailable"),
          ]),
        );

        const result = await session.send("search the web");

        expect(result.text).toContain("Search was unavailable");
        // tool.call.requested confirms the WebSearch was attempted
        const toolRequested = events.ofType("tool.call.requested");
        expect(toolRequested.some((e) => e.toolName === "WebSearch")).toBe(true);
        // The error is handled internally by the AI SDK, session completes
        expect(events.ofType("run.completed").length).toBe(1);
      } finally {
        if (originalApiKey !== undefined) {
          process.env.OPENROUTER_API_KEY = originalApiKey;
        }
        if (originalModel !== undefined) {
          process.env.OPENROUTER_WEBSEARCH_MODEL = originalModel;
        }
      }
    });
  });
});
