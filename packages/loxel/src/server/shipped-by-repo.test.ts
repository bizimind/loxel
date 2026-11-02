import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canGitReadRepo, isEnvShippedByRepo, isShippedByRepo } from "./shipped-by-repo";

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

describe("a repository git cannot read", () => {
  /** A worktree whose repository has lost its `HEAD`, which git reports with exit code 128. */
  async function makeUnreadableRepo(): Promise<string> {
    const root = await makeRepo();
    await rm(join(root, ".git", "HEAD"));
    return root;
  }

  test("counts everything inside the worktree as tracked, and nothing outside it", async () => {
    const root = await makeUnreadableRepo();
    expect(await canGitReadRepo(root)).toBe(false);
    expect(await isShippedByRepo(root, join(root, "built", "tool"))).toBe(true);
    expect(await isShippedByRepo(root, tmpdir())).toBe(false);
  });

  test("still counts an untracked symlink in the worktree that leads out of it", async () => {
    const root = await makeUnreadableRepo();
    await symlink(tmpdir(), join(root, "built", "link"));
    expect(await isShippedByRepo(root, join(root, "built", "link"))).toBe(true);
  });

  test("counts everything as tracked in a linked worktree whose git dir is gone", async () => {
    const root = await makeRepo();
    const git = (...args: string[]) =>
      expect(Bun.spawnSync(["git", "-C", root, ...args]).exitCode).toBe(0);
    git(
      "-c",
      "user.email=a@b",
      "-c",
      "user.name=a",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "i",
    );
    const linked = join(root, "built", "linked");
    git("worktree", "add", "-q", "--detach", linked);
    expect(await canGitReadRepo(linked)).toBe(true);
    await rm(join(root, ".git", "worktrees"), { recursive: true });
    expect(await canGitReadRepo(linked)).toBe(false);
    expect(await isShippedByRepo(linked, join(linked, "tracked", "tool"))).toBe(true);
  });

  test("recovers once git can read the repository again", async () => {
    const root = await makeUnreadableRepo();
    expect(await isShippedByRepo(root, join(root, "built", "tool"))).toBe(true);
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    expect(await isShippedByRepo(root, join(root, "built", "tool"))).toBe(false);
  });

  test("counts a path in the worktree as tracked when git is killed, as a timeout does", async () => {
    wt = await realpath(await mkdtemp(join(tmpdir(), "shipped-by-repo-")));
    await mkdir(join(wt, "bin"));
    await writeFile(join(wt, "bin", "git"), "#!/bin/sh\nkill -TERM $$\n", { mode: 0o755 });
    await writeFile(join(wt, "tool"), "");
    const originalPath = process.env.PATH;
    process.env.PATH = `${join(wt, "bin")}:${originalPath}`;
    try {
      expect(await canGitReadRepo(wt)).toBe(false);
      expect(await isShippedByRepo(wt, join(wt, "tool"))).toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("a folder in no repository has nothing tracked", async () => {
    wt = await realpath(await mkdtemp(join(tmpdir(), "shipped-by-repo-")));
    await writeFile(join(wt, "tool"), "");
    expect(await canGitReadRepo(wt)).toBe(true);
    expect(await isShippedByRepo(wt, join(wt, "tool"))).toBe(false);
  });

  test("counts everything as tracked in a repository set as bare", async () => {
    const root = await makeRepo();
    Bun.spawnSync(["git", "-C", root, "config", "core.bare", "true"]);
    expect(await canGitReadRepo(root)).toBe(false);
    expect(await isShippedByRepo(root, join(root, "built", "tool"))).toBe(true);
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
