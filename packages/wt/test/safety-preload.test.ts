import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { git, gitSucceeds, runGit } from "../src/git/index.ts";

const checkoutRoot = resolve(import.meta.dir, "../../..");

describe("test safety preload", () => {
  test("raw git cannot discover the host repo from below its root (ceiling)", async () => {
    const below = resolve(checkoutRoot, "packages", "wt");
    const result = await Bun.$`git -C ${below} rev-parse --git-dir`.nothrow().quiet();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("not a git repository");
  });

  test("wt's git helpers refuse the checkout root itself", async () => {
    await expect(runGit(["rev-parse", "--git-dir"], checkoutRoot)).rejects.toThrow("[TEST SAFETY]");
    await expect(git(["rev-parse", "--git-dir"], checkoutRoot)).rejects.toThrow("[TEST SAFETY]");
    await expect(gitSucceeds(["rev-parse"], checkoutRoot)).rejects.toThrow("[TEST SAFETY]");
  });

  test("wt's git helpers refuse a cwd inside the checkout, including the implicit one", async () => {
    await expect(runGit(["rev-parse", "--git-dir"])).rejects.toThrow("[TEST SAFETY]");
    await expect(runGit(["rev-parse", "--git-dir"], process.cwd())).rejects.toThrow(
      "[TEST SAFETY]",
    );
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
