import { describe, expect, test } from "bun:test";

import { runGit } from "../src/git/index.ts";

describe("test safety preload", () => {
  test("git cannot discover the host repo from process.cwd()", async () => {
    const result = await runGit(["rev-parse", "--git-dir"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not a git repository");
  });

  test("git cannot discover the host repo from an explicit cwd inside it", async () => {
    const result = await runGit(["rev-parse", "--git-dir"], process.cwd());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not a git repository");
  });

  test("git works in a temp-directory test repo", async () => {
    const { createTestRepo } = await import("../src/test-repo.ts");
    const repo = await createTestRepo();
    try {
      const result = await runGit(["rev-parse", "--git-dir"], repo.root);
      expect(result.exitCode).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });

  test("ambient git env vars are cleared", () => {
    const allowed = new Set([
      "GIT_CEILING_DIRECTORIES",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_TERMINAL_PROMPT",
    ]);
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("GIT_") && !allowed.has(key)) {
        expect.unreachable(`${key} should have been cleared by the preload`);
      }
    }
  });

  test("ambient wt and shell vars are cleared", () => {
    expect(process.env.WT_DIR).toBeUndefined();
    expect(process.env.WT_AUTO_UPDATE).toBeUndefined();
    expect(process.env.BASH_ENV).toBeUndefined();
    expect(process.env.ENV).toBeUndefined();
    expect(process.env.TMPDIR).toBeUndefined();
    expect(process.env.TMP).toBeUndefined();
    expect(process.env.TEMP).toBeUndefined();
  });

  test("git global and system config are neutralized", () => {
    expect(process.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(process.env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("process.chdir is blocked", () => {
    expect(() => process.chdir("/tmp")).toThrow("[TEST SAFETY]");
  });

  test("process.exit is blocked", () => {
    expect(() => process.exit(0)).toThrow("[TEST SAFETY]");
  });
});
