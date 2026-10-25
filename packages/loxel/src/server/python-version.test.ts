import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pythonVersion } from "./python-version";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

/** A fake interpreter: a shell script that counts its runs in `<script>.runs`. */
async function fakePython(body: string): Promise<{ python: string; runs: () => Promise<number> }> {
  root = await realpath(await mkdtemp(join(tmpdir(), "python-version-")));
  const python = join(root, "python");
  const counter = `${python}.runs`;
  await writeFile(python, `#!/bin/sh\necho x >> '${counter}'\n${body}\n`);
  await chmod(python, 0o755);
  const runs = async () => {
    const file = Bun.file(counter);
    return (await file.exists()) ? (await file.text()).split("\n").filter(Boolean).length : 0;
  };
  return { python, runs };
}

describe("pythonVersion", () => {
  test("reads the version once per interpreter file", async () => {
    const { python, runs } = await fakePython(`echo "Python 3.12.13"`);
    expect(await pythonVersion(python)).toBe("3.12.13");
    expect(await pythonVersion(python)).toBe("3.12.13");
    expect(await runs()).toBe(1);
  });

  test("reads Python 2's version from stderr", async () => {
    const { python } = await fakePython(`echo "Python 2.7.18" >&2`);
    expect(await pythonVersion(python)).toBe("2.7.18");
  });

  test("does not cache a failed read", async () => {
    // Prints nothing on its first run, a version afterwards.
    const { python, runs } = await fakePython(
      `[ "$(wc -l < "$0.runs")" -gt 1 ] && echo "Python 3.13.1"`,
    );
    expect(await pythonVersion(python)).toBeNull();
    expect(await pythonVersion(python)).toBe("3.13.1");
    expect(await runs()).toBe(2);
  });

  test("returns null for a missing file", async () => {
    expect(await pythonVersion("/nonexistent/python")).toBeNull();
  });
});
