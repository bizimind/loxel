import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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

    // A worktree outside `.worktrees` whose name matches a managed one must not run the other's.
    await post(ctx, "/api/worktree/create", { projectPath: repo, name: "feat" });
    const unmanaged = join(outside, "feat");
    await Bun.$`git -C ${repo} worktree add -q -b unmanaged ${unmanaged}`;
    await rm(join(repo, "init-ran-feat"));

    for (const path of [outside, repo, unmanaged]) {
      const [status] = await post(ctx, "/api/worktree/run-init-hook", { projectPath: repo, path });
      expect(status).not.toBe(200);
    }
    expect(existsSync(join(repo, "init-ran-main"))).toBe(false);
    expect(existsSync(join(repo, "init-ran-feat"))).toBe(false);
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
  // The route makes the initial commit with the server's environment, which has no identity in CI.
  const identity = {
    GIT_AUTHOR_NAME: "T",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "T",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const saved = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
  beforeAll(() => Object.assign(process.env, identity));
  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

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

describe("setting up an existing or cloned repository like wt init", () => {
  const projectCtx = {
    initializeProject: async () => ({}),
    broadcastAll: () => {},
    broadcastToProject: () => {},
    getProject: () => undefined,
  } as unknown as RouteContext;

  /** A remote with a `main` branch, as a clone URL, and a fresh directory to clone into. */
  async function makeRemote(): Promise<{ url: string; dest: string }> {
    const base = await realpath(await mkdtemp(join(tmpdir(), "routes-worktree-hooks-remote-")));
    roots.push(base);
    const upstream = join(base, "upstream");
    await Bun.$`git init -q --initial-branch=main ${upstream}`;
    await Bun.$`git -C ${upstream} -c user.email=t@example.com -c user.name=T commit -q --allow-empty -m init`;
    return { url: `file://${upstream}`, dest: join(base, "clones") };
  }

  const gitConfig = async (repoPath: string, key: string) =>
    (await Bun.$`git -C ${repoPath} config --get ${key}`.nothrow().quiet().text()).trim();

  test("a multi-workspace clone gets origin's refspec and origin/HEAD, and holds its hook back", async () => {
    const { url, dest } = await makeRemote();
    const [status, project] = await post<{ path: string; initHookSkippedAt?: string }>(
      projectCtx,
      "/api/projects/clone",
      {
        url,
        destination: dest,
        setup: "multi",
        copyFiles: [],
        setupCommands: ['touch "$WT_ROOT/setup-ran"'],
      },
    );

    const bareDir = join(dest, "upstream");
    const main = join(bareDir, ".worktrees", "main");
    expect(status).toBe(200);
    expect(project).toMatchObject({ path: bareDir, initHookSkippedAt: main });
    expect(await gitConfig(bareDir, "remote.origin.fetch")).toBe(
      "+refs/heads/*:refs/remotes/origin/*",
    );
    const originHead = await Bun.$`git -C ${bareDir} symbolic-ref refs/remotes/origin/HEAD`.text();
    expect(originHead.trim()).toBe("refs/remotes/origin/main");
    expect(existsSync(main)).toBe(true);
    expect(existsSync(join(bareDir, "setup-ran"))).toBe(false);
    expect(getRepoTrustStatus(main).restrictions).toEqual([WORKTREE_HOOKS_RESTRICTION]);
  });

  test("detect reports what wt doctor finds in a plain bare clone, with wt init's fixes", async () => {
    const { url, dest } = await makeRemote();
    const bareDir = join(dest, "plain.git");
    await Bun.$`git clone -q --bare -- ${url} ${bareDir}`;

    const [, detected] = await post<{
      type: string;
      setup?: {
        checks: Array<{ id: string; status: string }>;
        actions: Array<{ id: string; recommended: boolean }>;
      };
    }>(projectCtx, "/api/projects/detect", { path: bareDir });

    expect(detected.type).toBe("git-repo-bare");
    expect(detected.setup?.checks).toContainEqual(
      expect.objectContaining({ id: "fetch-refspec", status: "warn" }),
    );
    expect(detected.setup?.checks.some((check) => check.status === "ok")).toBe(false);
    const recommended = detected.setup?.actions.filter((action) => action.recommended);
    expect(recommended?.map((action) => action.id)).toEqual(["fetch-refspec", "main-worktree"]);
  });

  test("adding an existing repository applies the chosen fixes, its hook held back", async () => {
    const { url, dest } = await makeRemote();
    const bareDir = join(dest, "plain.git");
    await Bun.$`git clone -q --bare -- ${url} ${bareDir}`;
    await Bun.write(join(bareDir, "init.wt.sh"), 'touch "$WT_ROOT/init-ran"\n');

    const [status, project] = await post<{ path: string; initHookSkippedAt?: string }>(
      projectCtx,
      "/api/projects",
      { path: bareDir, apply: ["fetch-refspec", "main-worktree"] },
    );

    const main = join(bareDir, ".worktrees", "main");
    expect(status).toBe(200);
    expect(project).toMatchObject({ path: bareDir, initHookSkippedAt: main });
    expect(await gitConfig(bareDir, "remote.origin.fetch")).not.toBe("");
    expect(existsSync(main)).toBe(true);
    expect(existsSync(join(bareDir, "init-ran"))).toBe(false);
  });

  test("adding a repository whose fix fails still adds it, set up as far as the fixes got", async () => {
    const { url, dest } = await makeRemote();
    const bareDir = join(dest, "offline.git");
    await Bun.$`git clone -q --bare -- ${url} ${bareDir}`;
    // As when origin can't be reached: the fetch fails, the default branch's worktree does not.
    await Bun.$`git -C ${bareDir} remote set-url origin ${join(dest, "gone")}`;

    const [status, project] = await post<{ path: string; setupFailures?: string }>(
      projectCtx,
      "/api/projects",
      { path: bareDir, apply: ["fetch-refspec", "main-worktree"] },
    );

    expect(status).toBe(200);
    expect(project.path).toBe(bareDir);
    expect(project.setupFailures).toStartWith("fetch-refspec: ");
    expect(existsSync(join(bareDir, ".worktrees", "main"))).toBe(true);
  });

  test("detect plans a regular repository's setup, but not a linked worktree's", async () => {
    const { url, dest } = await makeRemote();
    const checkout = join(dest, "checkout");
    await Bun.$`git clone -q -- ${url} ${checkout}`;
    const linked = join(dest, "linked");
    await Bun.$`git -C ${checkout} worktree add -q -b topic ${linked}`;

    const [, regular] = await post<{ type: string; setup?: unknown }>(
      projectCtx,
      "/api/projects/detect",
      { path: checkout },
    );
    const [, worktree] = await post<{ type: string; setup?: unknown }>(
      projectCtx,
      "/api/projects/detect",
      { path: linked },
    );

    expect(regular.type).toBe("git-repo-regular");
    expect(regular.setup).toMatchObject({ checks: expect.any(Array), actions: expect.any(Array) });
    expect(worktree.type).toBe("git-repo-regular");
    expect(worktree.setup).toBeUndefined();
  });

  test("adding refuses setup actions that are not a list, or turn metadata on and off", async () => {
    const { url, dest } = await makeRemote();
    const bareDir = join(dest, "plain.git");
    await Bun.$`git clone -q --bare -- ${url} ${bareDir}`;

    for (const apply of ["fetch-refspec", ["worktree-metadata-on", "worktree-metadata-off"]]) {
      const [status] = await post(projectCtx, "/api/projects", { path: bareDir, apply });
      expect(status).toBe(400);
    }
  });

  test("adding refuses an unknown setup action without changing the repository", async () => {
    const { url, dest } = await makeRemote();
    const bareDir = join(dest, "plain.git");
    await Bun.$`git clone -q --bare -- ${url} ${bareDir}`;

    const [status, body] = await post<{ error: string }>(projectCtx, "/api/projects", {
      path: bareDir,
      apply: ["fetch-refspec", "format-disk"],
    });

    expect(status).toBe(400);
    expect(body.error).toContain("format-disk");
    expect(await gitConfig(bareDir, "remote.origin.fetch")).toBe("");
  });
});
