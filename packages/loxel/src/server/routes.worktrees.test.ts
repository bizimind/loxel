import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setWorktreeMeta } from "@bizimind/wt/lib";

import { listProjectWorktrees, projectWorktreesResponse } from "./project-worktrees";
import type { RouteContext } from "./routes";
import { handleRequest } from "./routes";
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
  let suspended = 0;
  let resumed = 0;
  let completed = 0;

  beforeEach(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), "loxel-wt-")));
    suspended = 0;
    resumed = 0;
    completed = 0;
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
      sendToActiveWindow: () => false,
      sendToWorktreeWindows: () => {},
      externalFolderConflict: () => null,
      getProject: (cwd) => (cwd === repo ? project : undefined),
      findProjectForPath: () => undefined,
      getWorktreeResources: () => undefined,
      suspendWorktreeWatchers: async () => {
        suspended++;
        return async () => {
          resumed++;
        };
      },
      completeWorktreeRemoval: () => {
        completed++;
      },
      resolveFilePath: () => null,
      initializeProject: async () => ({ project, worktrees: [] }),
      teardownProject: () => {},
      shutdown: () => {},
      resolveSchema: async () => ({}),
      updateYamlSchemas: () => {},
      updateTomlSchemas: () => {},
      formatContent: async () => ({ content: null }),
      getDetectedFormatters: () => [],
      activeWindow: () => null,
      startTerminal: async () => {},
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
    expect({ suspended, resumed, completed }).toEqual({ suspended: 1, resumed: 1, completed: 0 });
    const forced = await post("/api/worktree/remove", {
      projectPath: repo,
      path: wtPath,
      force: true,
      deleteBranch: true,
    });
    expect(forced.status).toBe(200);
    expect(existsSync(wtPath)).toBe(false);
    expect(await branches(repo)).not.toContain("feat-x");
    expect({ suspended, resumed, completed }).toEqual({ suspended: 2, resumed: 1, completed: 1 });
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

  test("enabling worktree metadata is planned, applied once, then no longer offered", async () => {
    const planned = async () => {
      const res = await post("/api/worktree/plan-enable-metadata", { projectPath: repo });
      return ((await res.json()) as { action: { id: string } | null }).action;
    };
    expect((await planned())?.id).toBe("worktree-metadata-on");
    expect((await projectWorktreesResponse(repo)).worktreeMetadata).toBe(false);

    expect((await post("/api/worktree/enable-metadata", { projectPath: repo })).status).toBe(200);

    expect(await planned()).toBeNull();
    expect((await projectWorktreesResponse(repo)).worktreeMetadata).toBe(true);
  });

  describe("nesting", () => {
    const wtPath = (name: string) => join(repo, ".worktrees", name);

    async function byName() {
      const worktrees = await listProjectWorktrees(repo);
      return Object.fromEntries(worktrees.map((wt) => [wt.wtName, wt]));
    }

    async function meta(path: string, update: Record<string, unknown>): Promise<Response> {
      return post("/api/worktree/meta", { projectPath: repo, path, ...update });
    }

    beforeEach(async () => {
      expect((await post("/api/worktree/enable-metadata", { projectPath: repo })).status).toBe(200);
    });

    test("a child branches from its parent's commit and is nested under it", async () => {
      expect((await create("parent")).status).toBe(200);
      await writeFile(join(wtPath("parent"), "work.txt"), "work\n");
      await git(wtPath("parent"), "add", ".");
      await git(wtPath("parent"), "commit", "-m", "parent work");

      expect((await create("child", { parentPath: wtPath("parent") })).status).toBe(200);

      const { parent, child } = await byName();
      expect(parent?.wtId).toBeString();
      expect(child?.parentWtId).toBe(parent!.wtId!);
      expect(child?.commit).toBe(parent!.commit);
    });

    test("nests, un-nests and renames, and refuses to nest under a descendant", async () => {
      await create("a");
      await create("b");
      expect((await meta(wtPath("b"), { parentPath: wtPath("a") })).status).toBe(200);
      expect((await byName()).b?.parentWtId).toBe((await byName()).a!.wtId!);

      const cycle = await meta(wtPath("a"), { parentPath: wtPath("b") });
      expect(cycle.status).toBe(400);
      expect(((await cycle.json()) as { error: string }).error).toContain("cannot be nested");

      expect((await meta(wtPath("b"), { parentPath: null, title: " Bee " })).status).toBe(200);
      expect((await byName()).b?.parentWtId).toBeUndefined();
      expect((await byName()).b?.title).toBe("Bee");

      expect((await meta(wtPath("b"), { title: "" })).status).toBe(200);
      expect((await byName()).b?.title).toBeUndefined();
    });

    test("creates a worktree with a title, nested under its parent", async () => {
      await create("parent");
      expect(
        (await create("titled", { parentPath: wtPath("parent"), title: " My task " })).status,
      ).toBe(200);
      const { parent, titled } = await byName();
      expect(titled?.title).toBe("My task");
      expect(titled?.parentWtId).toBe(parent!.wtId!);
    });

    test("reads a title stored under the old key, and clears it when the title changes", async () => {
      await create("old");
      await setWorktreeMeta({
        repoPath: repo,
        path: wtPath("old"),
        values: { "loxel-pretty-name": "Old title" },
      });
      expect((await byName()).old?.title).toBe("Old title");

      expect((await meta(wtPath("old"), { title: "" })).status).toBe(200);
      expect((await byName()).old?.title).toBeUndefined();
    });

    test("removing a parent moves its children up to its own parent", async () => {
      await create("top");
      await create("mid", { parentPath: wtPath("top") });
      await create("leaf", { parentPath: wtPath("mid") });

      const plan = await post("/api/worktree/plan-remove", {
        projectPath: repo,
        path: wtPath("mid"),
      });
      expect(
        ((await plan.json()) as { nested: { path: string; dirty: boolean }[] }).nested,
      ).toEqual([{ path: wtPath("leaf"), dirty: false }]);

      const res = await post("/api/worktree/remove", { projectPath: repo, path: wtPath("mid") });
      expect(res.status).toBe(200);
      const { top, mid, leaf } = await byName();
      expect(mid).toBeUndefined();
      expect(leaf?.parentWtId).toBe(top!.wtId!);
    });

    test("removing a parent with its nested worktrees removes the whole subtree", async () => {
      await create("top");
      await create("mid", { parentPath: wtPath("top") });
      await create("leaf", { parentPath: wtPath("mid") });

      const res = await post("/api/worktree/remove", {
        projectPath: repo,
        path: wtPath("top"),
        nested: "remove",
        nestedPaths: [wtPath("mid"), wtPath("leaf")],
      });
      expect(res.status).toBe(200);
      expect(Object.keys(await byName())).toEqual([]);
    });

    test("removing a subtree leaves a nested worktree the user did not confirm", async () => {
      await create("top");
      await create("seen", { parentPath: wtPath("top") });
      await create("late", { parentPath: wtPath("top") });

      const res = await post("/api/worktree/remove", {
        projectPath: repo,
        path: wtPath("top"),
        nested: "remove",
        nestedPaths: [wtPath("seen")],
      });
      expect(res.status).toBe(200);
      expect(Object.keys(await byName())).toEqual(["late"]);
    });
  });
});
