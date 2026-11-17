import { describe, expect, test } from "bun:test";

import { cliSocketPath } from "./socket-paths";

describe("cliSocketPath", () => {
  test("is in the state directory's run directory while a socket path there fits", () => {
    const stateDir = "/Users/me/.local/state/loxel/loxel";
    expect(cliSocketPath(stateDir, "/tmp")).toBe(`${stateDir}/run/cli.sock`);
  });

  test("a state directory too deep for a socket path keeps it in the temp dir", () => {
    const deep = `/Users/me/${"nested/".repeat(12)}state`;
    const socket = cliSocketPath(deep, "/var/tmp-user");
    expect(socket).toMatch(/^\/var\/tmp-user\/loxel-run-[0-9a-f]{12}\/cli\.sock$/);
    // Every process for the same state directory finds the same one.
    expect(cliSocketPath(deep, "/var/tmp-user")).toBe(socket);
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
  });
});
