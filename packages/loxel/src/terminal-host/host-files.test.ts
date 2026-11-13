import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureRunDir,
  hostRunDir,
  hostSocketDir,
  hostSocketPath,
  isHostId,
  newHostId,
} from "./host-files";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("host files", () => {
  test("host IDs are short enough for socket paths, and checked", () => {
    const id = newHostId();
    expect(isHostId(id)).toBe(true);
    expect(isHostId("../evil")).toBe(false);
  });

  test("sockets are in the run directory while a socket path there fits", () => {
    const stateDir = "/Users/me/.local/state/loxel/loxel";
    expect(hostRunDir(stateDir)).toBe("/Users/me/.local/state/loxel/loxel/terminal-host/run");
    expect(hostSocketDir(stateDir, "/tmp")).toBe(hostRunDir(stateDir));
  });

  test("a state directory too deep for a socket path keeps its sockets in the temp dir", () => {
    const deep = `/Users/me/${"nested/".repeat(12)}state`;
    const socketDir = hostSocketDir(deep, "/var/tmp-user");
    expect(socketDir).toMatch(/^\/var\/tmp-user\/loxel-terminal-host-[0-9a-f]{12}$/);
    // The same state directory always finds the same one, and its entries stay in it.
    expect(hostSocketDir(deep, "/var/tmp-user")).toBe(socketDir);
    expect(hostRunDir(deep)).toBe(`${deep}/terminal-host/run`);
    expect(Buffer.byteLength(hostSocketPath(socketDir, newHostId()))).toBeLessThanOrEqual(103);
  });

  test("the run directory is made private, also when it already exists", () => {
    const base = mkdtempSync(join(tmpdir(), "thf-"));
    dirs.push(base);
    const runDir = join(base, "run");
    ensureRunDir(runDir);
    expect(statSync(runDir).mode & 0o777).toBe(0o700);
    chmodSync(runDir, 0o755);
    ensureRunDir(runDir);
    expect(statSync(runDir).mode & 0o777).toBe(0o700);
  });
});
