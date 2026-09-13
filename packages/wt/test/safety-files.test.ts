import { describe, expect, test } from "bun:test";

import { isBunTestFile, safetyReviewedFiles } from "./safety-files.ts";

describe("wt test safety manifest", () => {
  test("covers tests, shared helpers, the warning, and preload configuration", async () => {
    const files = await safetyReviewedFiles();

    expect(files).toContain("../../bunfig.toml");
    expect(files).toContain("bunfig.toml");
    expect(files).toContain("package.json");
    expect(files).toContain("TEST_SAFETY.md");
    expect(files).toContain("src/test-repo.ts");
    expect(files).toContain("src/git/name.test.ts");
    expect(files).toContain("src/lib/remove.test.ts");
    expect(files).toContain("test/safety-preload.ts");
    expect(files).not.toContain("test/approved-test-hash.ts");
  });

  test("sanitizes ambient repository and shell configuration", () => {
    expect(process.env.WT_DIR).toBeUndefined();
    expect(process.env.WT_AUTO_UPDATE).toBeUndefined();
    expect(process.env.BASH_ENV).toBeUndefined();
    expect(process.env.ENV).toBeUndefined();
    expect(process.env.TMPDIR).toBeUndefined();
    expect(process.env.TMP).toBeUndefined();
    expect(process.env.TEMP).toBeUndefined();
    expect(process.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(process.env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("recognizes every Bun test filename form", () => {
    for (const path of [
      "thing.test.js",
      "thing.test.jsx",
      "thing.test.ts",
      "thing.test.tsx",
      "thing_test.ts",
      "thing.spec.ts",
      "thing_spec.tsx",
    ]) {
      expect(isBunTestFile(path)).toBe(true);
    }
    expect(isBunTestFile("thing.ts")).toBe(false);
  });
});
