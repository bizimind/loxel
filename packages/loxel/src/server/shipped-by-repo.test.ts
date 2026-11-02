import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isEnvShippedByRepo, isShippedByRepo } from "./shipped-by-repo";

let wt: string | undefined;

afterEach(async () => {
  if (wt) await rm(wt, { recursive: true, force: true });
  wt = undefined;
});

/** A git worktree with `tracked/tool` committed to the index and `built/tool` left untracked. */
async function makeRepo(): Promise<string> {
  wt = await realpath(await mkdtemp(join(tmpdir(), "shipped-by-repo-")));
  Bun.spawnSync(["git", "-C", wt, "init", "-q"]);
  await mkdir(join(wt, "tracked"));
  await mkdir(join(wt, "built"));
  await writeFile(join(wt, "tracked", "tool"), "");
  await writeFile(join(wt, "built", "tool"), "");
  Bun.spawnSync(["git", "-C", wt, "add", "tracked/tool"]);
  return wt;
}

describe("isShippedByRepo", () => {
  test("is true for a tracked file and a directory holding one, false for untracked ones", async () => {
    const root = await makeRepo();
    expect(await isShippedByRepo(root, join(root, "tracked", "tool"))).toBe(true);
    expect(await isShippedByRepo(root, join(root, "tracked"))).toBe(true);
    expect(await isShippedByRepo(root, join(root, "built", "tool"))).toBe(false);
  });

  test("does not start the repository's configured file system monitor", async () => {
    const root = await makeRepo();
    const canary = join(root, "monitor-ran");
    const monitor = join(root, "built", "monitor");
    await writeFile(monitor, `#!/bin/sh\ntouch "${canary}"\n`);
    await chmod(monitor, 0o755);
    Bun.spawnSync(["git", "-C", root, "config", "core.fsmonitor", monitor]);
    await isShippedByRepo(root, join(root, "tracked", "tool"));
    expect(await Bun.file(canary).exists()).toBe(false);
  });

  test("follows an untracked symlink to a tracked target", async () => {
    const root = await makeRepo();
    await symlink(join(root, "tracked", "tool"), join(root, "built", "link"));
    expect(await isShippedByRepo(root, join(root, "built", "link"))).toBe(true);
  });

  test("treats a path that cannot be checked as tracked instead of failing", async () => {
    const root = await makeRepo();
    expect(await isShippedByRepo(root, join(root, "gone", "tool"))).toBe(true);
  });
});

describe("isEnvShippedByRepo", () => {
  test("is true when the directory or the executable is tracked, false otherwise", async () => {
    const root = await makeRepo();
    const built = join(root, "built");
    expect(await isEnvShippedByRepo(root, built, join(built, "tool"))).toBe(false);
    expect(await isEnvShippedByRepo(root, join(root, "tracked"), join(built, "tool"))).toBe(true);
    expect(await isEnvShippedByRepo(root, built, join(root, "tracked", "tool"))).toBe(true);
  });
});
