import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import "@/test/temp-state-dir";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setRepoTrusted } from "../repo-trust";
import { readOnlyGitEnv } from "./git-env";

const CONFIG_VARS = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];

const saved = new Map(CONFIG_VARS.map((name) => [name, process.env[name]]));

beforeEach(() => {
  for (const name of CONFIG_VARS) delete process.env[name];
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("readOnlyGitEnv", () => {
  test("turns fsmonitor off", () => {
    expect(readOnlyGitEnv()).toMatchObject({
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "false",
    });
  });

  test("leaves fsmonitor to the user's Git configuration only in a trusted repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "git-env-"));
    try {
      expect(readOnlyGitEnv(dir).GIT_CONFIG_KEY_0).toBe("core.fsmonitor");
      setRepoTrusted(dir, true);
      expect(readOnlyGitEnv(dir).GIT_OPTIONAL_LOCKS).toBe("0");
      expect(readOnlyGitEnv(dir).GIT_CONFIG_COUNT).toBeUndefined();
      expect(readOnlyGitEnv().GIT_CONFIG_KEY_0).toBe("core.fsmonitor");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps config variables already in the environment", () => {
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "user.name";
    process.env.GIT_CONFIG_VALUE_0 = "someone";
    expect(readOnlyGitEnv()).toMatchObject({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "someone",
      GIT_CONFIG_KEY_1: "core.fsmonitor",
      GIT_CONFIG_VALUE_1: "false",
    });
  });
});
