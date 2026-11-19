import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isServerId } from "@/api/worktree-ref";

import { loadServerId } from "./server-identity";

// Under the preloaded test state directory, which is removed after the run.
const freshDir = () => mkdtempSync(join(process.env.LOXEL_STATE_DIR ?? tmpdir(), "server-id-"));

describe("loadServerId", () => {
  test("creates the ID once and returns the same one on every later start", () => {
    const stateDir = join(freshDir(), "nested");
    const first = loadServerId(stateDir);

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    // The renderer takes it as a server id where it arrives.
    expect(isServerId(first)).toBe(true);
    expect(loadServerId(stateDir)).toBe(first);
    expect(readFileSync(join(stateDir, "server-id"), "utf8").trim()).toBe(first);
  });

  test("replaces a file that holds no ID", () => {
    const stateDir = freshDir();
    writeFileSync(join(stateDir, "server-id"), "garbage");

    const id = loadServerId(stateDir);

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(loadServerId(stateDir)).toBe(id);
  });
});
