import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

// Each test runs a handful of git commands, which are slow on some machines.
setDefaultTimeout(30_000);

const script = join(import.meta.dir, "install-hooks.sh");

let repo: string;

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "init.defaultBranch=main", ...args], {
    cwd: repo,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function install(): void {
  const result = Bun.spawnSync([script], { cwd: repo });
  expect(result.exitCode).toBe(0);
}

async function writeHook(name: string, marker: string): Promise<void> {
  await Bun.write(join(repo, ".githooks", name), `#!/bin/sh\ntouch "${join(repo, marker)}"\n`);
  Bun.spawnSync(["chmod", "+x", join(repo, ".githooks", name)]);
}

function exists(name: string): Promise<boolean> {
  return Bun.file(join(repo, name)).exists();
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "install-hooks-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await Bun.write(join(repo, ".gitignore"), "*.marker\n");
  await writeHook("pre-commit", "pre-commit.marker");
  git("add", "-A");
  git("commit", "-q", "--no-verify", "-m", "init");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("install-hooks.sh", () => {
  test("points core.hooksPath at an absolute directory outside the work tree", () => {
    install();
    const hooksPath = git("config", "core.hooksPath");
    expect(isAbsolute(hooksPath)).toBe(true);
    expect(hooksPath.startsWith(join(git("rev-parse", "--absolute-git-dir"), ""))).toBe(true);
  });

  test("runs the installed pre-commit hook on commit", async () => {
    install();
    await Bun.write(join(repo, "file.txt"), "change\n");
    git("add", "file.txt");
    git("commit", "-q", "-m", "change");
    expect(await exists("pre-commit.marker")).toBe(true);
  });

  test("does not run a hook that only exists on the checked-out branch", async () => {
    install();
    git("switch", "-q", "-c", "other");
    await writeHook("post-checkout", "post-checkout.marker");
    git("add", "-A");
    git("commit", "-q", "--no-verify", "-m", "add hook");
    git("switch", "-q", "main");
    git("switch", "-q", "other");
    expect(await exists("post-checkout.marker")).toBe(false);
  });

  test("drops a hook that was removed from .githooks", async () => {
    await writeHook("pre-push", "pre-push.marker");
    install();
    const hooksPath = git("config", "core.hooksPath");
    expect(await Bun.file(join(hooksPath, "pre-push")).exists()).toBe(true);

    rmSync(join(repo, ".githooks", "pre-push"));
    install();
    expect(await Bun.file(join(hooksPath, "pre-push")).exists()).toBe(false);
  });
});
