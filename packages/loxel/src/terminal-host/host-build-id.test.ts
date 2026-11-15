import { describe, expect, test } from "bun:test";

import { TERMINAL_HOST_ENTRY, computeHostBuildId } from "./host-build-id";

describe("computeHostBuildId", () => {
  test("names a separate generation for each CPU architecture", async () => {
    const [own, arm64, x64] = await Promise.all([
      computeHostBuildId(),
      computeHostBuildId(TERMINAL_HOST_ENTRY, "arm64"),
      computeHostBuildId(TERMINAL_HOST_ENTRY, "x64"),
    ]);
    expect(arm64).not.toBe(x64);
    // The build script and a server run from source both hash this process's architecture.
    expect(own).toBe(process.arch === "x64" ? x64 : arm64);
  });
});
