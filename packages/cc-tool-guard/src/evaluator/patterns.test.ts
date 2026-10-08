import { describe, expect, test } from "bun:test";

import type { ProjectContext } from "../types.ts";
import { checkKnownPatterns } from "./patterns.ts";

const context: ProjectContext = {
  projectRoot: "/home/user/project",
  currentBranch: "feature",
  cwd: "/home/user/project",
  isGitRepo: true,
};

function classify(command: string): string | null {
  return checkKnownPatterns(command, context)?.classification ?? null;
}

describe("dangerous rm patterns", () => {
  describe("recursive delete of the current or parent directory", () => {
    test.each([
      "rm -rf .",
      "rm -rf ./",
      "rm -fr .",
      "rm -r -f .",
      "rm -R .",
      "rm --recursive .",
      "rm --recursive --force .",
      "rm -rf -- .",
      "rm -rf ..",
      "rm -rf dist .",
      "rm -rf . dist",
      'rm -rf "."',
      "rm -rf '.'",
      "rm -rf './'",
    ])("%s is uncertain", (command) => {
      expect(classify(command)).toBe("uncertain");
    });
  });

  describe("recursive delete with a wildcard glob in the current directory", () => {
    test.each([
      "rm -rf *",
      "rm -rf *.js",
      "rm -rf ./*",
      "rm -rf -- *",
      "rm -r -f *.log",
      "rm -rf .*",
      "rm -fr .*",
      "rm --recursive .*",
      "rm -rf ./.*",
      "rm -rf .[!.]*",
      "rm -rf .??*",
      "rm -rf '.*'",
      'rm -rf ".*"',
      "rm -rf dist .*",
    ])("%s is uncertain", (command) => {
      expect(classify(command)).toBe("uncertain");
    });
  });

  describe("scoped recursive deletes are not flagged as cwd deletes", () => {
    test.each([
      "rm -rf ./dist",
      "rm -rf .cache",
      "rm -rf '.cache'",
      "rm -rf dist",
      "rm -rf dist/*.map",
      "rm -rf node_modules/*",
      "rm -rf ..cache",
    ])("%s is not uncertain", (command) => {
      expect(classify(command)).not.toBe("uncertain");
    });
  });

  test("non-recursive rm of a glob is not matched by the recursive rules", () => {
    const result = checkKnownPatterns("rm *.log", context);
    expect(result?.reason).not.toMatch(/Recursive/);
  });
});

describe("package runner commands are not auto-approved", () => {
  test.each(["npx some-package", "bun x some-package"])("%s is not safe", (command) => {
    expect(classify(command)).not.toBe("safe");
  });

  test("bun run is still safe", () => {
    expect(classify("bun run build")).toBe("safe");
  });
});
