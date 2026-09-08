import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RouteContext } from "./routes";
import { handleRequest, writeInitHook } from "./routes";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("generated init.wt.sh", () => {
  test("copies quoted nested paths and runs setup commands in the worktree", async () => {
    root = await mkdtemp(join(tmpdir(), "loxel-project-setup-"));
    const worktree = join(root, "worktree");
    const file = "config/user's settings.env";
    await mkdir(join(root, ".wt-local-res", "config"), { recursive: true });
    await mkdir(worktree);
    await writeFile(join(root, ".wt-local-res", file), "TOKEN=value\n");

    await writeInitHook(root, [file], ["printf 'ready\\n' > setup.txt"]);
    await chmod(join(root, "init.wt.sh"), 0o755);
    const proc = Bun.spawn(["bash", join(root, "init.wt.sh")], {
      cwd: worktree,
      env: { ...process.env, WT_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await proc.exited).toBe(0);
    expect(await Bun.file(join(worktree, file)).text()).toBe("TOKEN=value\n");
    expect(await Bun.file(join(worktree, "setup.txt")).text()).toBe("ready\n");
  });

  test("rejects paths that escape the local resource directory", async () => {
    root = await mkdtemp(join(tmpdir(), "loxel-project-setup-"));
    await expect(writeInitHook(root, ["../secret"], [])).rejects.toThrow("without traversal");
    expect(await Bun.file(join(root, "init.wt.sh")).exists()).toBe(false);
  });
});

describe("project conversion preflight", () => {
  async function seedRepo(): Promise<string> {
    root = await mkdtemp(join(tmpdir(), "loxel-project-convert-"));
    await runGit(root, "init", "--initial-branch=main", ".");
    await runGit(root, "config", "user.email", "test@example.com");
    await runGit(root, "config", "user.name", "Test");
    await writeFile(join(root, "README.md"), "test\n");
    await runGit(root, "add", ".");
    await runGit(root, "commit", "-m", "initial");
    return root;
  }

  function context(onTeardown: () => void): RouteContext {
    return {
      broadcastToSubscribers: () => {},
      broadcastToProject: () => {},
      broadcastAll: () => {},
      getProject: () => undefined,
      findProjectForPath: () => undefined,
      getWorktreeResources: () => undefined,
      resolveFilePath: () => null,
      initializeProject: async () => ({ project: {} as never, worktrees: [] }),
      teardownProject: onTeardown,
      shutdown: () => {},
      resolveSchema: async () => ({}),
      updateYamlSchemas: () => {},
      formatContent: async () => null,
      getDetectedFormatters: () => [],
    };
  }

  test("rejects detached HEAD without tearing down the live project", async () => {
    const repo = await seedRepo();
    await runGit(repo, "checkout", "--detach");
    let teardownCount = 0;

    const response = await handleRequest(
      new Request("http://localhost/api/projects/convert", {
        method: "POST",
        body: JSON.stringify({ path: repo, copyFiles: [], setupCommands: [] }),
      }),
      context(() => teardownCount++),
    );

    expect(response.status).toBe(400);
    expect(teardownCount).toBe(0);
    expect(existsSync(join(repo, ".git"))).toBe(true);
  });

  test("rejects existing linked worktrees without tearing down the live project", async () => {
    const repo = await seedRepo();
    await writeFile(join(repo, ".git", "info", "exclude"), "linked/\n");
    await runGit(repo, "worktree", "add", "-b", "linked", join(repo, "linked"));
    let teardownCount = 0;

    const response = await handleRequest(
      new Request("http://localhost/api/projects/convert", {
        method: "POST",
        body: JSON.stringify({ path: repo, copyFiles: [], setupCommands: [] }),
      }),
      context(() => teardownCount++),
    );

    expect(response.status).toBe(400);
    expect(teardownCount).toBe(0);
    expect(existsSync(join(repo, ".git"))).toBe(true);
  });
});

async function runGit(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}
