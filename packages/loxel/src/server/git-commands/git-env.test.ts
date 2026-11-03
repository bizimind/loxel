import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setRepoTrusted } from "../repo-trust";
import { readOnlyGitEnv } from "./git-env";

const OFF = "'core.fsmonitor=false'";
const saved = process.env.GIT_CONFIG_PARAMETERS;

beforeEach(() => {
  delete process.env.GIT_CONFIG_PARAMETERS;
});

afterEach(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_PARAMETERS;
  else process.env.GIT_CONFIG_PARAMETERS = saved;
});

describe("readOnlyGitEnv", () => {
  test("turns fsmonitor off", () => {
    expect(readOnlyGitEnv()).toMatchObject({ GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_PARAMETERS: OFF });
  });

  test("leaves fsmonitor to the user's Git configuration only in a trusted repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "git-env-"));
    try {
      expect(readOnlyGitEnv(dir).GIT_CONFIG_PARAMETERS).toBe(`${OFF} 'log.showSignature=false'`);
      setRepoTrusted(dir, true);
      expect(readOnlyGitEnv(dir).GIT_OPTIONAL_LOCKS).toBe("0");
      expect(readOnlyGitEnv(dir).GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(readOnlyGitEnv().GIT_CONFIG_PARAMETERS).toBe(OFF);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps config parameters already in the environment", () => {
    process.env.GIT_CONFIG_PARAMETERS = "'user.name=someone'";
    expect(readOnlyGitEnv().GIT_CONFIG_PARAMETERS).toBe(`'user.name=someone' ${OFF}`);
  });
});
