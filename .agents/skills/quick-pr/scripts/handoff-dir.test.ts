import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "handoff-dir.sh");

let state: string;

function run(...args: string[]) {
  return Bun.spawnSync([script, ...args], { env: { ...process.env, XDG_STATE_HOME: state } });
}

function mode(path: string): number {
  // oxlint-disable-next-line no-bitwise -- permission bits
  return statSync(path).mode & 0o777;
}

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "handoff-dir-"));
});

afterEach(() => {
  rmSync(state, { recursive: true, force: true });
});

describe("handoff-dir.sh", () => {
  test("prints a directory only its owner can open", () => {
    const result = run();
    expect(result.exitCode).toBe(0);
    const dir = result.stdout.toString().trim();
    expect(dir).toBe(join(state, "agent-handoff"));
    expect(mode(dir)).toBe(0o700);
  });

  test("creates a private subdirectory", () => {
    const dir = run("orchestrate").stdout.toString().trim();
    expect(dir).toBe(join(state, "agent-handoff", "orchestrate"));
    expect(mode(join(state, "agent-handoff"))).toBe(0o700);
    expect(mode(dir)).toBe(0o700);
  });

  test("tightens an existing directory that others can open", () => {
    mkdirSync(join(state, "agent-handoff"), { mode: 0o777 });
    expect(run().exitCode).toBe(0);
    expect(mode(join(state, "agent-handoff"))).toBe(0o700);
  });

  test("refuses a directory that is a link", () => {
    const elsewhere = join(state, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(state, "agent-handoff"));
    const result = run();
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
  });
});
