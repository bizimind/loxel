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
      "rm -rf ../",
      "rm -rf ../..",
      "rm -rf ./..",
      "rm -rf ../../../..",
      "rm -rf dist .",
      "rm -rf . dist",
      'rm -rf "."',
      "rm -rf '.'",
      "rm -rf './'",
    ])("%s is uncertain", (command) => {
      expect(classify(command)).toBe("uncertain");
    });
  });

  describe("recursive delete with a wildcard glob in the current or parent directory", () => {
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
      "rm -rf ../*",
      "rm -rf ../../*",
      "rm -rf ../.*",
      "rm -rf -- ../*",
      "rm -rf .[!.]*",
      "rm -rf .??*",
      "rm -rf '.*'",
      'rm -rf ".*"',
      "rm -rf dist .*",
      "rm -rf {*,.*}",
      "rm -rf {.,}*",
      "rm -rf ./{*,.*}",
      "rm -rf .{git,}",
      "rm -rf .{a,b}*",
      "rm -rf {dist,build}*",
      "rm -rf ./{dist,}",
    ])("%s is uncertain", (command) => {
      expect(classify(command)).toBe("uncertain");
    });
  });

  describe("scoped recursive deletes are not flagged as cwd deletes", () => {
    test.each([
      "rm -rf ./dist",
      "rm -rf ../dist",
      "rm -rf ../../dist",
      "rm -rf .cache",
      "rm -rf '.cache'",
      "rm -rf dist",
      "rm -rf dist/*.map",
      "rm -rf node_modules/*",
      "rm -rf ..cache",
      "rm -rf {dist,build}",
      "rm -rf dist/{a,b}",
    ])("%s is not uncertain", (command) => {
      expect(classify(command)).not.toBe("uncertain");
    });
  });

  describe("rm as a package manager subcommand or git rm --cached is not a recursive delete", () => {
    test.each([
      "git rm -r --cached .",
      "git rm --cached -r .",
      "git rm -r --cached *",
      "pnpm rm -r .",
      "npm rm -r .",
    ])("%s is not matched by the recursive rules", (command) => {
      expect(checkKnownPatterns(command, context)?.reason ?? "").not.toMatch(/Recursive delete/);
    });
  });

  describe("git rm without --cached deletes from the working tree", () => {
    test.each(["git rm -rf .", "git rm -r .", "git rm -rf ./*", "env git rm -rf ."])(
      "%s is uncertain",
      (command) => {
        expect(classify(command)).toBe("uncertain");
      },
    );
  });

  describe("prefixed and chained rm still match", () => {
    test.each(["sudo rm -rf .", "cd x && rm -rf .", "env rm -rf *", "ls; rm -rf ./.*"])(
      "%s is uncertain",
      (command) => {
        expect(classify(command)).toBe("uncertain");
      },
    );
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
