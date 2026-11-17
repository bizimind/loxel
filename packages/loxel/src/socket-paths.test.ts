import { describe, expect, test } from "bun:test";

import { cliSocketPath, cliSocketTempPath } from "./socket-paths";

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

  test("leaves room for a server's temporary name at the longest state directory that fits", () => {
    // The deepest state directory whose run directory still holds the socket.
    let stateDir = "/s";
    while (cliSocketPath(`${stateDir}x`, "/tmp").startsWith(`${stateDir}x/run/`)) stateDir += "x";
    const socket = cliSocketPath(stateDir, "/tmp");
    expect(socket).toBe(`${stateDir}/run/cli.sock`);

    const temp = cliSocketTempPath(socket);
    expect(temp).toMatch(/\/cli\.sock\.[0-9a-f]{8}$/);
    expect(Buffer.byteLength(temp)).toBe(103);
  });
});

describe("cliSocketTempPath", () => {
  test("is a fresh name beside the socket each time", () => {
    const socket = "/state/run/cli.sock";
    expect(cliSocketTempPath(socket)).toMatch(/^\/state\/run\/cli\.sock\.[0-9a-f]{8}$/);
    expect(cliSocketTempPath(socket)).not.toBe(cliSocketTempPath(socket));
  });
});
