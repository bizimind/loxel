import { describe, expect, test } from "bun:test";

import { $ } from "bun";

import { describeError } from "../error-message";
import { drainSpawnStats } from "../spawn-metrics";
import { readOnlyGitEnv } from "./git-env";
import { GitCommandError, gitText, runGit } from "./run-git";
import { commit, createRepo } from "./test-utils";

const MISSING_DIR = "/nonexistent/loxel-run-git";

async function withRepo<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
  const repo = await createRepo();
  try {
    return await fn(repo.path);
  } finally {
    await repo.cleanup();
  }
}

describe("runGit", () => {
  test("returns stdout, matching the Bun shell byte for byte", async () => {
    await withRepo(async (cwd) => {
      const sha = await commit(cwd, "first ünïcode", { "a.txt": "1" });
      const format = "%H %s";
      const viaShell = await $`git -C ${cwd} log --format=${format}`.text();
      expect(await gitText(["log", `--format=${format}`], { cwd })).toBe(viaShell);
      expect(viaShell).toContain(sha);
    });
  });

  test("a failure throws what Bun's ShellError carries, with its message", async () => {
    const shellError: unknown = await $`git -C ${MISSING_DIR} status`.quiet().catch((e) => e);
    const error: unknown = await runGit(["status"], { cwd: MISSING_DIR }).catch((e) => e);

    expect(error).toBeInstanceOf(GitCommandError);
    const failure = error as GitCommandError;
    const shell = shellError as $.ShellError;
    expect(failure.message).toBe(shell.message);
    expect(failure.exitCode).toBe(shell.exitCode);
    expect(failure.stderr).toBe(shell.stderr.toString());
    expect(describeError(failure, "x")).toBe(describeError(shell, "x"));
  });

  test("nothrow returns the failure, a missing directory is git's own exit code", async () => {
    const result = await runGit(["status"], { cwd: MISSING_DIR, nothrow: true });
    expect(result.exitCode).toBe(128);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("cannot change to");
  });

  test("a git that cannot be started is a failed result, not a spawn exception", async () => {
    const env = { PATH: "/nonexistent" };
    const result = await runGit(["status"], { env, nothrow: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("git");
    expect(runGit(["status"], { env })).rejects.toBeInstanceOf(GitCommandError);
  });

  test("passes stdin, as text or bytes", async () => {
    await withRepo(async (cwd) => {
      const viaText = await gitText(["hash-object", "--stdin"], { cwd, stdin: "hello" });
      const viaBytes = await gitText(["hash-object", "--stdin"], {
        cwd,
        stdin: new TextEncoder().encode("hello"),
      });
      expect(viaBytes).toBe(viaText);
      // An empty input reaches git as an immediate EOF rather than hanging.
      expect((await gitText(["hash-object", "--stdin"], { cwd, stdin: "" })).trim()).toBe(
        "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
      );
    });
  });

  test("passes env as the child's whole environment, defaulting to the current one", async () => {
    await withRepo(async (cwd) => {
      const read = (env?: Record<string, string>) =>
        gitText(["var", "GIT_AUTHOR_IDENT"], { cwd, env, nothrow: true });
      const author = { ...readOnlyGitEnv(), GIT_AUTHOR_NAME: "Env Author" };
      expect(await read(author)).toContain("Env Author");

      // Set after the server started: `Bun.spawn`'s own default would not see this.
      process.env.GIT_AUTHOR_NAME = "Live Author";
      try {
        expect(await read()).toContain("Live Author");
      } finally {
        delete process.env.GIT_AUTHOR_NAME;
      }
    });
  });

  test("passes global options ahead of the subcommand", async () => {
    await withRepo(async (cwd) => {
      const value = await gitText(["-c", "loxel.test=yes", "config", "--get", "loxel.test"], {
        cwd,
      });
      expect(value.trim()).toBe("yes");
    });
  });

  test("records each spawn under its subcommand, whatever the outcome", async () => {
    await withRepo(async (cwd) => {
      drainSpawnStats();
      await gitText(["-c", "a.b=c", "-C", cwd, "rev-parse", "--git-dir"]);
      await runGit(["no-such-subcommand"], { cwd, nothrow: true });
      const stats = drainSpawnStats();
      expect(stats.spawns).toBe(2);
      expect(stats.childWallMs.total).toBeGreaterThan(0);
      expect(stats.top.map((entry) => entry.label).sort()).toEqual([
        "git no-such-subcommand",
        "git rev-parse",
      ]);
    });
  });
});
