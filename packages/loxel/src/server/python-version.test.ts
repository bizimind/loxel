import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
    expect(await pythonVersion(python, root!)).toBe("3.12.13");
    expect(await pythonVersion(python, root!)).toBe("3.12.13");
    expect(await runs()).toBe(1);
  });

  test("reads Python 2's version from stderr", async () => {
    const { python } = await fakePython(`echo "Python 2.7.18" >&2`);
    expect(await pythonVersion(python, root!)).toBe("2.7.18");
  });

  test("does not cache a failed read", async () => {
    // Prints nothing on its first run, a version afterwards.
    const { python, runs } = await fakePython(
      `[ "$(wc -l < "$0.runs")" -gt 1 ] && echo "Python 3.13.1"`,
    );
    expect(await pythonVersion(python, root!)).toBeNull();
    expect(await pythonVersion(python, root!)).toBe("3.13.1");
    expect(await runs()).toBe(2);
  });

  test("asks from the worktree, so a version-manager shim reads its .python-version", async () => {
    // Like a pyenv shim: the version comes from `.python-version` in the working directory.
    const { python } = await fakePython(`echo "Python $(cat .python-version)"`);
    const wt = join(root!, "wt");
    await mkdir(wt);
    await writeFile(join(wt, ".python-version"), "3.11.9\n");
    expect(await pythonVersion(python, wt)).toBe("3.11.9");
  });

  test("returns null for a missing file", async () => {
    expect(await pythonVersion("/nonexistent/python", tmpdir())).toBeNull();
  });
});
