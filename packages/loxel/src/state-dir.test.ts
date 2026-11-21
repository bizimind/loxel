import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensurePrivateStateDir } from "./state-dir";

const modeOf = (path: string) => statSync(path).mode & 0o777;

describe("ensurePrivateStateDir", () => {
  let root: string;
  let base: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "loxel-state-dir-"));
    base = join(root, "loxel");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("creates the state directory and the base directory private", () => {
    const stateDir = join(base, "loxel");
    ensurePrivateStateDir(stateDir, base);
    expect(modeOf(base)).toBe(0o700);
    expect(modeOf(stateDir)).toBe(0o700);
  });

  test("makes the directories of an existing install private, leaving their files alone", () => {
    const stateDir = join(base, "loxel");
    mkdirSync(join(stateDir, "logs"), { recursive: true });
    chmodSync(base, 0o755);
    chmodSync(stateDir, 0o755);
    ensurePrivateStateDir(stateDir, base);
    expect(modeOf(base)).toBe(0o700);
    expect(modeOf(stateDir)).toBe(0o700);
    expect(modeOf(join(stateDir, "logs"))).toBe(0o755);
  });

  test("a state directory elsewhere leaves the base directory alone", () => {
    const stateDir = join(root, "elsewhere");
    ensurePrivateStateDir(stateDir, base);
    expect(modeOf(stateDir)).toBe(0o700);
    expect(() => statSync(base)).toThrow();
  });

  test("follows a state directory that links elsewhere", () => {
    const target = join(root, "target");
    mkdirSync(target, { mode: 0o755 });
    const stateDir = join(root, "linked");
    symlinkSync(target, stateDir);
    ensurePrivateStateDir(stateDir, base);
    expect(modeOf(target)).toBe(0o700);
  });
});
