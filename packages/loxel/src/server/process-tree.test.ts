import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isWtRunningBelow, psOutputHasDescendant } from "./process-tree";

describe("psOutputHasDescendant", () => {
  const ps = `
    1     0 /sbin/launchd
  100     1 /bin/zsh
  101   100 /Users/me/App Support/claude
  102   101 /bin/zsh
  103   102 /Users/me/.local/bin/wt
  200     1 /bin/zsh
  201   200 /opt/not-wt
  300     1 wt
`;

  test("finds it at any depth, on macOS's full paths with spaces in them", () => {
    expect(psOutputHasDescendant(ps, 100, "wt")).toBe(true);
  });

  test("only below the given process, and only by its exact name", () => {
    expect(psOutputHasDescendant(ps, 200, "wt")).toBe(false);
    expect(psOutputHasDescendant(ps, 102, "wt")).toBe(true);
    expect(psOutputHasDescendant(ps, 103, "wt")).toBe(false);
  });

  test("reads a bare command name, as on Linux", () => {
    expect(psOutputHasDescendant(ps, 1, "wt")).toBe(true);
  });

  test("survives a cycle in a snapshot taken while PIDs change", () => {
    expect(psOutputHasDescendant("  5  6 a\n  6  5 b\n", 5, "wt")).toBe(false);
  });
});

test("isWtRunningBelow sees a real process named wt, until it exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "process-tree-"));
  const wt = join(dir, "wt");
  const source = join(dir, "main.ts");
  // A copy of a system binary would not do: macOS kills it for its signature.
  writeFileSync(source, `await Bun.file(process.argv[2]).exists(); await Bun.sleep(300_000);`);
  const built = Bun.spawnSync(["bun", "build", "--compile", source, "--outfile", wt], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());

  // The shell stays the parent, so the process found is a descendant, not the root.
  const shell = Bun.spawn(["/bin/sh", "-c", `"${wt}" x; :`], { stdout: "ignore" });
  try {
    while (!(await isWtRunningBelow(shell.pid))) await Bun.sleep(10);
    expect(await isWtRunningBelow(process.pid)).toBe(true);

    Bun.spawnSync(["pkill", "-f", wt]);
    await shell.exited;
    expect(await isWtRunningBelow(shell.pid)).toBe(false);
  } finally {
    shell.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
