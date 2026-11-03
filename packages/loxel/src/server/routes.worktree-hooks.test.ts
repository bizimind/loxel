import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Trust lives in the store database; keep the tests' state out of the real one.
const stateDir = await mkdtemp(join(tmpdir(), "routes-worktree-hooks-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { handleRequest } = await import("./routes");
const { getRepoTrustStatus, isRepoTrusted, setRepoTrusted } = await import("./repo-trust");
const { WORKTREE_HOOKS_RESTRICTION } = await import("./worktree-hooks");
type RouteContext = import("./routes").RouteContext;

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

/**
 * A regular repository whose main checkout holds hooks that leave a marker at the repo root when
 * they run, as a cloned repository could commit them.
 */
async function makeRepo(): Promise<{ repo: string; ctx: RouteContext }> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "routes-worktree-hooks-")));
  roots.push(repo);
  await Bun.$`git init -q --initial-branch=main ${repo}`;
  await Bun.$`git -C ${repo} -c user.email=t@example.com -c user.name=T commit -q --allow-empty -m init`;
  await Bun.write(join(repo, "init.wt.sh"), 'touch "$WT_ROOT/init-ran-$WT_NAME"\n');
  await Bun.write(join(repo, "clean.wt.sh"), 'touch "$WT_ROOT/clean-ran-$WT_NAME"\n');

  const project = { cwd: repo, isBare: false, worktreesDir: join(repo, ".worktrees") };
  const ctx = {
    broadcastToProject: () => {},
    getProject: (cwd: string) => (cwd === repo ? project : undefined),
    suspendWorktreeWatchers: async () => async () => {},
    completeWorktreeRemoval: () => {},
  } as unknown as RouteContext;
  return { repo, ctx };
}

async function post<T>(ctx: RouteContext, path: string, body: unknown): Promise<[number, T]> {
  const res = await handleRequest(
    new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body) }),
    ctx,
  );
  return [res.status, (await res.json()) as T];
}

let repo: string;
let ctx: RouteContext;

beforeEach(async () => {
  ({ repo, ctx } = await makeRepo());
});

describe("worktree hooks in an untrusted repository", () => {
  test("creating a worktree holds init.wt.sh back, reports it, and runs it once trusted", async () => {
    const [status, created] = await post<{ path: string; hookRan: boolean; hookSkipped?: true }>(
      ctx,
      "/api/worktree/create",
      { projectPath: repo, name: "feat" },
    );

    expect(status).toBe(200);
    expect(created).toMatchObject({ hookRan: false, hookSkipped: true });
    expect(existsSync(join(repo, "init-ran-feat"))).toBe(false);
    expect(getRepoTrustStatus(created.path).restrictions).toEqual([WORKTREE_HOOKS_RESTRICTION]);

    const body = { projectPath: repo, path: created.path };
    const [refusedStatus] = await post(ctx, "/api/worktree/run-init-hook", body);
    expect(refusedStatus).not.toBe(200);
    expect(existsSync(join(repo, "init-ran-feat"))).toBe(false);

    setRepoTrusted(created.path, true);
    expect(await post(ctx, "/api/worktree/run-init-hook", body)).toEqual([200, { hookRan: true }]);
    expect(existsSync(join(repo, "init-ran-feat"))).toBe(true);
  });

  test("run-init-hook refuses a path that is not one of the project's worktrees", async () => {
    setRepoTrusted(repo, true);
    const outside = await realpath(await mkdtemp(join(tmpdir(), "routes-worktree-hooks-other-")));
    roots.push(outside);

    for (const path of [outside, repo]) {
      const [status] = await post(ctx, "/api/worktree/run-init-hook", { projectPath: repo, path });
      expect(status).not.toBe(200);
    }
    expect(existsSync(join(repo, "init-ran-main"))).toBe(false);
  });

  test("removing a worktree says clean.wt.sh is held back, and does not run it", async () => {
    const [, created] = await post<{ path: string }>(ctx, "/api/worktree/create", {
      projectPath: repo,
      name: "feat",
    });
    const target = { projectPath: repo, path: created.path };

    const [, plan] = await post<{ hasHook: boolean; cleanHookHeld: boolean }>(
      ctx,
      "/api/worktree/plan-remove",
      target,
    );
    expect(plan).toMatchObject({ hasHook: true, cleanHookHeld: true });

    const [status] = await post(ctx, "/api/worktree/remove", target);
    expect(status).toBe(200);
    expect(existsSync(created.path)).toBe(false);
    expect(existsSync(join(repo, "clean-ran-feat"))).toBe(false);
  });
});

describe("worktree hooks in a trusted repository", () => {
  test("creating and removing a worktree runs its hooks", async () => {
    setRepoTrusted(repo, true);

    const [, created] = await post<{ path: string; hookRan: boolean; hookSkipped?: true }>(
      ctx,
      "/api/worktree/create",
      { projectPath: repo, name: "feat" },
    );
    expect(created.hookRan).toBe(true);
    expect(created.hookSkipped).toBeUndefined();
    expect(existsSync(join(repo, "init-ran-feat"))).toBe(true);

    const target = { projectPath: repo, path: created.path };
    const [, plan] = await post<{ cleanHookHeld: boolean }>(
      ctx,
      "/api/worktree/plan-remove",
      target,
    );
    expect(plan.cleanHookHeld).toBe(false);

    await post(ctx, "/api/worktree/remove", target);
    expect(existsSync(join(repo, "clean-ran-feat"))).toBe(true);
  });
});

describe("a project created from scratch", () => {
  const projectCtx = {
    initializeProject: async () => ({}),
    broadcastAll: () => {},
  } as unknown as RouteContext;

  async function createProject(setup: "single" | "multi") {
    const location = await realpath(await mkdtemp(join(tmpdir(), "routes-worktree-hooks-new-")));
    roots.push(location);
    const [status] = await post(projectCtx, "/api/projects/create", {
      name: "fresh",
      location,
      setup,
      copyFiles: [],
      setupCommands: ['touch "$WT_ROOT/setup-ran"'],
    });
    expect(status).toBe(200);
    return join(location, "fresh");
  }

  test("starts trusted, so its first worktree's init.wt.sh runs", async () => {
    const projectDir = await createProject("multi");
    const firstWorktree = join(projectDir, ".worktrees", "main");

    expect(isRepoTrusted(firstWorktree)).toBe(true);
    expect(existsSync(join(projectDir, "setup-ran"))).toBe(true);
    expect(getRepoTrustStatus(firstWorktree).restrictions).toEqual([]);
  });

  test("starts trusted as a single checkout", async () => {
    expect(isRepoTrusted(await createProject("single"))).toBe(true);
  });
});
