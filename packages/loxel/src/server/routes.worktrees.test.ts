import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RouteContext } from "./routes";
import { handleRequest, listProjectWorktrees } from "./routes";
import type { ProjectState } from "./server-state";

/** Run a git command in `cwd`, throwing with stderr on failure. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

async function branches(repo: string): Promise<string[]> {
  const out = await git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads");
  return out.split("\n").filter(Boolean);
}

describe("worktree routes on a regular (non-bare) repo", () => {
  let repo: string;
  let ctx: RouteContext;

  beforeEach(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), "loxel-wt-")));
    await git(repo, "init", "--initial-branch=main", ".");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test");
    await writeFile(join(repo, "README.md"), "hi\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "init");

    // Only cwd/worktreesDir are read by the worktree handlers under test.
    const project = {
      cwd: repo,
      isBare: false,
      worktreesDir: join(repo, ".worktrees"),
    } as ProjectState;

    ctx = {
      broadcastToSubscribers: () => {},
      broadcastToProject: () => {},
      broadcastAll: () => {},
      getProject: (cwd) => (cwd === repo ? project : undefined),
      findProjectForPath: () => undefined,
      getWorktreeResources: () => undefined,
      resolveFilePath: () => null,
      initializeProject: async () => ({ project, worktrees: [] }),
      teardownProject: () => {},
      shutdown: () => {},
      resolveSchema: async () => ({}),
      updateYamlSchemas: () => {},
      formatContent: async () => null,
      getDetectedFormatters: () => [],
    };
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  function post(path: string, body: unknown): Promise<Response> {
    return handleRequest(
      new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) }),
      ctx,
    );
  }

  async function create(name: string, extra: Record<string, unknown> = {}): Promise<Response> {
    return post("/api/worktree/create", { projectPath: repo, name, ...extra });
  }

  test("creates and lists worktrees, including nested names", async () => {
    expect((await create("feat/nested")).status).toBe(200);

    const worktrees = await listProjectWorktrees(repo);
    expect(worktrees.map((wt) => wt.wtName)).toEqual(["feat/nested"]);
    expect(worktrees[0]!.path).toBe(join(repo, ".worktrees", "feat", "nested"));
  });

  test("create on an existing branch reports git's message, not an exit code", async () => {
    await git(repo, "branch", "existing-br");

    const res = await create("existing-br");
    expect(res.status).not.toBe(200);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? "").toContain("existing-br");
    expect(body.error ?? "").not.toMatch(/^Failed with exit code \d+$/);
  });

  test("plan-remove reports untracked files as dirty", async () => {
    expect((await create("feat-x")).status).toBe(200);
    await writeFile(join(repo, ".worktrees", "feat-x", ".env"), "SECRET=1\n");

    const res = await post("/api/worktree/plan-remove", {
      projectPath: repo,
      path: join(repo, ".worktrees", "feat-x"),
    });
    expect(res.status).toBe(200);
    const plan = (await res.json()) as { name: string; dirty: boolean; branch: string | null };
    expect(plan.name).toBe("feat-x");
    expect(plan.dirty).toBe(true);
    expect(plan.branch).toBe("feat-x");
  });

  test("remove of a dirty worktree fails without force and succeeds with it", async () => {
    expect((await create("feat-x")).status).toBe(200);
    const wtPath = join(repo, ".worktrees", "feat-x");
    await writeFile(join(wtPath, ".env"), "SECRET=1\n");

    const refused = await post("/api/worktree/remove", { projectPath: repo, path: wtPath });
    expect(refused.status).not.toBe(200);
    expect(existsSync(wtPath)).toBe(true);

    const forced = await post("/api/worktree/remove", {
      projectPath: repo,
      path: wtPath,
      force: true,
      deleteBranch: true,
    });
    expect(forced.status).toBe(200);
    expect(existsSync(wtPath)).toBe(false);
    expect(await branches(repo)).not.toContain("feat-x");
  });

  test("remove keeps the branch when deleteBranch is false", async () => {
    expect((await create("feat-y")).status).toBe(200);
    const wtPath = join(repo, ".worktrees", "feat-y");

    const res = await post("/api/worktree/remove", {
      projectPath: repo,
      path: wtPath,
      force: true,
      deleteBranch: false,
    });
    expect(res.status).toBe(200);
    expect(existsSync(wtPath)).toBe(false);
    expect(await branches(repo)).toContain("feat-y");
  });

  test("remove rejects a path outside the project", async () => {
    const res = await post("/api/worktree/remove", {
      projectPath: repo,
      path: join(repo, "..", "elsewhere"),
    });
    expect(res.status).not.toBe(200);
    expect(existsSync(join(repo, ".."))).toBe(true);
  });

  test("remove cannot validate one worktree path and resolve another with the same basename", async () => {
    expect((await create("collision")).status).toBe(200);
    const managedPath = join(repo, ".worktrees", "collision");
    const externalPath = join(repo, "external", "collision");
    await git(repo, "worktree", "add", "-b", "external-collision", externalPath);

    const planned = await post("/api/worktree/plan-remove", {
      projectPath: repo,
      path: externalPath,
    });
    expect(planned.status).toBe(400);

    const removed = await post("/api/worktree/remove", {
      projectPath: repo,
      path: externalPath,
      force: true,
    });
    expect(removed.status).not.toBe(200);
    expect(existsSync(managedPath)).toBe(true);
    expect(existsSync(externalPath)).toBe(true);
  });
});
