import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestDirectory, type TestDirectory } from "../test-repo.ts";
import { structuralNameError, worktreeNameError } from "./name.ts";

let directory: TestDirectory | undefined;

function testCwd(): string {
  if (!directory) throw new Error("wt test directory was not initialized");
  return directory.root;
}

beforeAll(async () => {
  directory = await createTestDirectory();
});

afterAll(async () => {
  await directory?.cleanup();
});

describe("worktreeNameError", () => {
  test("accepts a simple name", async () => {
    expect(await worktreeNameError("feature-x", testCwd())).toBeNull();
  });

  test("accepts a nested name", async () => {
    expect(await worktreeNameError("feat/add-voice-input", testCwd())).toBeNull();
    expect(await worktreeNameError("a/b/c", testCwd())).toBeNull();
  });

  test("rejects an empty name", async () => {
    expect(await worktreeNameError("")).toBe("name must not be empty");
  });

  test("rejects a name starting with a dash", async () => {
    expect(await worktreeNameError("-force")).toBe("name must not start with '-'");
  });

  test("rejects an absolute path", async () => {
    expect(await worktreeNameError("/etc/passwd")).toBe(
      "name must be relative to the worktrees directory",
    );
  });

  test.each([["../escape"], ["a/../b"], ["a/./b"], ["a//b"], ["trailing/"]])(
    "rejects path segment escape %p",
    async (name) => {
      expect(await worktreeNameError(name)).toBe(
        "name must not contain empty, '.' or '..' path segments",
      );
    },
  );

  test.each([["bad name"], ["bad~name"], ["bad^name"], ["bad:name"], ["feat/.hidden"]])(
    "rejects invalid git ref %p",
    async (name) => {
      expect(await worktreeNameError(name, testCwd())).toBe(
        `'${name}' is not a valid git branch name`,
      );
    },
  );
});

describe("structuralNameError", () => {
  test("passes names git has to judge", () => {
    expect(structuralNameError("bad name")).toBeNull();
    expect(structuralNameError("feat/foo")).toBeNull();
  });

  test("catches path shape without invoking git", () => {
    expect(structuralNameError("..")).not.toBeNull();
    expect(structuralNameError("-x")).not.toBeNull();
  });
});
