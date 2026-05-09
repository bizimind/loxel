import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";

import { PermissionStore } from "../src/permissions/store.ts";

const originalHome = process.env.HOME;
const originalStateRoot = process.env.CODING_AGENT_STATE_ROOT;

describe("PermissionStore", () => {
  let testHome: string;
  const workspaceRoot = path.join(process.cwd(), "perm-workspace");

  beforeEach(() => {
    testHome = path.join(process.cwd(), "tmp-test-home", `permissions-${Date.now()}`);
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

  test("allow_this_session persists only in current session store", async () => {
    const sessionA = new PermissionStore(workspaceRoot, "session_a");
    const sessionB = new PermissionStore(workspaceRoot, "session_b");

    const input = { command: "echo hi" };
    await sessionA.persistDecision("Bash", input, "allow_this_session");

    expect(await sessionA.isAllowed("Bash", input)).toBe(true);
    expect(await sessionB.isAllowed("Bash", input)).toBeUndefined();
  });

  test("allow_always persists to project scope across sessions", async () => {
    const sessionA = new PermissionStore(workspaceRoot, "session_a");
    const sessionB = new PermissionStore(workspaceRoot, "session_b");

    const input = { file_path: path.join(workspaceRoot, "a.txt"), content: "x" };
    await sessionA.persistDecision("Write", input, "allow_always");

    expect(await sessionA.isAllowed("Write", input)).toBe(true);
    expect(await sessionB.isAllowed("Write", input)).toBe(true);
  });

  test("allow and deny are not persisted", async () => {
    const session = new PermissionStore(workspaceRoot, "session_a");
    const input = { file_path: path.join(workspaceRoot, "a.txt"), content: "x" };

    await session.persistDecision("Write", input, "allow");
    await session.persistDecision("Write", input, "deny");

    expect(await session.isAllowed("Write", input)).toBeUndefined();
  });

  test("concurrent persistence does not drop decisions", async () => {
    const session = new PermissionStore(workspaceRoot, "session_concurrent");
    const inputA = { command: "echo a" };
    const inputB = { command: "echo b" };

    await Promise.all([
      session.persistDecision("Bash", inputA, "allow_this_session"),
      session.persistDecision("Bash", inputB, "allow_this_session"),
    ]);

    expect(await session.isAllowed("Bash", inputA)).toBe(true);
    expect(await session.isAllowed("Bash", inputB)).toBe(true);
  });

  describe("Bash fingerprint ignores non-semantic fields", () => {
    test("same command with different description matches", async () => {
      const session = new PermissionStore(workspaceRoot, "session_bash");

      await session.persistDecision(
        "Bash",
        { command: "pwd", description: "Print working directory" },
        "allow_this_session",
      );

      expect(
        await session.isAllowed("Bash", { command: "pwd", description: "Show current dir" }),
      ).toBe(true);
      expect(await session.isAllowed("Bash", { command: "pwd" })).toBe(true);
    });

    test("same command with different timeout matches", async () => {
      const session = new PermissionStore(workspaceRoot, "session_bash_timeout");

      await session.persistDecision("Bash", { command: "ls", timeout: 5000 }, "allow_this_session");

      expect(await session.isAllowed("Bash", { command: "ls", timeout: 10000 })).toBe(true);
      expect(await session.isAllowed("Bash", { command: "ls" })).toBe(true);
    });

    test("different commands do not match", async () => {
      const session = new PermissionStore(workspaceRoot, "session_bash_diff");

      await session.persistDecision("Bash", { command: "pwd" }, "allow_this_session");

      expect(await session.isAllowed("Bash", { command: "ls" })).toBeUndefined();
    });
  });

  describe("file-write tools share workspace-scoped permission", () => {
    test("approving Edit also approves Write and MultiEdit in workspace", async () => {
      const session = new PermissionStore(workspaceRoot, "session_fw");
      const editInput = {
        file_path: path.join(workspaceRoot, "src/app.ts"),
        old_string: "foo",
        new_string: "bar",
      };

      await session.persistDecision("Edit", editInput, "allow_this_session");

      // Write to a different file in the same workspace is approved
      expect(
        await session.isAllowed("Write", {
          file_path: path.join(workspaceRoot, "other.txt"),
          content: "hello",
        }),
      ).toBe(true);

      // MultiEdit in the same workspace is approved
      expect(
        await session.isAllowed("MultiEdit", {
          file_path: path.join(workspaceRoot, "deep/nested/file.ts"),
          edits: [{ old_string: "a", new_string: "b" }],
        }),
      ).toBe(true);
    });

    test("file writes outside workspace are not covered by workspace permission", async () => {
      const session = new PermissionStore(workspaceRoot, "session_fw_outside");

      await session.persistDecision(
        "Write",
        { file_path: path.join(workspaceRoot, "in.txt"), content: "x" },
        "allow_this_session",
      );

      expect(
        await session.isAllowed("Write", { file_path: "/tmp/outside.txt", content: "x" }),
      ).toBeUndefined();
    });

    test("workspace permission does not leak to prefix-matching paths", async () => {
      const session = new PermissionStore(workspaceRoot, "session_fw_prefix");

      await session.persistDecision(
        "Edit",
        { file_path: path.join(workspaceRoot, "a.ts"), old_string: "x", new_string: "y" },
        "allow_this_session",
      );

      // workspaceRoot is "…/perm-workspace", this path starts with the same prefix but is different
      expect(
        await session.isAllowed("Write", {
          file_path: `${workspaceRoot}-other/file.txt`,
          content: "x",
        }),
      ).toBeUndefined();
    });
  });
});
