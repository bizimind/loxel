import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TERMINAL_HOST_BINARY, hostBinDir, hostRunDir, newHostId } from "./host-files";
import { installHostBinary, launchHost } from "./host-launcher";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "thl-"));
  dirs.push(dir);
  return dir;
}

describe("installHostBinary", () => {
  test("copies the bundled binary to bin/<hostBuildId>/ once, executable, and reuses it", () => {
    const stateDir = tempDir();
    const bundled = join(tempDir(), TERMINAL_HOST_BINARY);
    writeFileSync(bundled, "#!/bin/sh\n");
    chmodSync(bundled, 0o755);

    const installed = installHostBinary(stateDir, "build-1", bundled);
    expect(installed).toBe(join(hostBinDir(stateDir), "build-1", TERMINAL_HOST_BINARY));
    expect(statSync(installed).mode & 0o111).not.toBe(0);

    // A later bundle with the same build ID is the same host: the installed copy stays.
    writeFileSync(bundled, "#!/bin/sh\n# changed\n");
    expect(installHostBinary(stateDir, "build-1", bundled)).toBe(installed);
    expect(readFileSync(installed, "utf8")).toBe("#!/bin/sh\n");
  });
});

describe("launchHost", () => {
  test("fails, pointing at the host's stderr, when it exits before its socket is up", async () => {
    const stateDir = tempDir();
    const hostId = newHostId();
    const launch = launchHost({
      stateDir,
      runDir: hostRunDir(stateDir),
      hostId,
      hostBuildId: "b",
      command: ["/bin/sh", "-c", "echo broken >&2; exit 3", "host"],
    });
    await expect(launch).rejects.toThrow(`terminal-host-${hostId}.log.stderr`);
    const stderr = readFileSync(
      join(stateDir, "logs", `terminal-host-${hostId}.log.stderr`),
      "utf8",
    );
    expect(stderr).toBe("broken\n");
  });
});
