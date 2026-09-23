import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DetachedFilesService } from "./detached-files-service";
import type { RouteContext } from "./routes";
import { handleRequest } from "./routes";
import type { WorktreeResources } from "./server-state";

describe("detached file project destinations", () => {
  let root: string;
  let wt: string;
  let detachedDir: string;
  let service: DetachedFilesService;
  let ctx: RouteContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "loxel-routes-"));
    wt = join(root, "worktree");
    detachedDir = join(root, "detached");
    await mkdir(join(wt, "src"), { recursive: true });
    await mkdir(detachedDir, { recursive: true });
    await writeFile(join(detachedDir, "Draft.md"), "draft");

    service = new DetachedFilesService(detachedDir, () => {});
    await service.start();

    const resources = { detachedFilesService: service } as WorktreeResources;

    ctx = {
      broadcastToSubscribers: () => {},
      broadcastToProject: () => {},
      broadcastAll: () => {},
      getProject: () => undefined,
      findProjectForPath: () => undefined,
      getWorktreeResources: (path) => (path === wt ? resources : undefined),
      suspendWorktreeWatchers: async () => async () => {},
      completeWorktreeRemoval: () => {},
      resolveFilePath: () => null,
      initializeProject: async () => ({ project: {} as never, worktrees: [] }),
      teardownProject: () => {},
      shutdown: () => {},
      resolveSchema: async () => ({}),
      updateYamlSchemas: () => {},
      formatContent: async () => null,
      getDetectedFormatters: () => [],
    };
  });

  afterEach(async () => {
    service.stop();
    await rm(root, { recursive: true, force: true });
  });

  test("copy accepts a relative destination", async () => {
    const res = await post("/api/detached-file-copy-to-project", {
      wt,
      path: join(detachedDir, "Draft.md"),
      destPath: "src",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ newPath: join(wt, "src", "Draft.md") });
  });

  test("move accepts an absolute destination inside the worktree", async () => {
    const res = await post("/api/detached-file-move", {
      wt,
      path: join(detachedDir, "Draft.md"),
      destPath: join(wt, "src"),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ newPath: join(wt, "src", "Draft.md") });
  });

  test("copy rejects an absolute destination outside the worktree", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);

    const res = await post("/api/detached-file-copy-to-project", {
      wt,
      path: join(detachedDir, "Draft.md"),
      destPath: outside,
    });

    expect(res.status).toBe(400);
  });

  test("move carries images referenced by relative path along with the draft", async () => {
    await writeFile(join(detachedDir, "Shot.md"), "![a](./shot-1.png)\n![b](missing.png)\n");
    await writeFile(join(detachedDir, "shot-1.png"), "png");
    await writeFile(join(detachedDir, "unrelated.png"), "png");

    const res = await post("/api/detached-file-move", {
      wt,
      path: join(detachedDir, "Shot.md"),
      destPath: "src",
    });

    expect(res.status).toBe(200);
    expect((await readdir(join(wt, "src"))).sort()).toEqual(["Shot.md", "shot-1.png"]);
    expect((await readdir(detachedDir)).sort()).toEqual(["Draft.md", "unrelated.png"]);
  });

  test("copy keeps the draft and its images, and refuses to overwrite either", async () => {
    await writeFile(join(detachedDir, "Shot.md"), "![a](./shot-1.png)");
    await writeFile(join(detachedDir, "shot-1.png"), "png");
    await writeFile(join(wt, "src", "shot-1.png"), "existing");

    const clash = await post("/api/detached-file-copy-to-project", {
      wt,
      path: join(detachedDir, "Shot.md"),
      destPath: "src",
    });
    expect(clash.status).toBe(500);
    expect(await readdir(join(wt, "src"))).toEqual(["shot-1.png"]);

    await rm(join(wt, "src", "shot-1.png"));
    const res = await post("/api/detached-file-copy-to-project", {
      wt,
      path: join(detachedDir, "Shot.md"),
      destPath: "src",
    });
    expect(res.status).toBe(200);
    expect((await readdir(join(wt, "src"))).sort()).toEqual(["Shot.md", "shot-1.png"]);
    expect((await readdir(detachedDir)).sort()).toEqual(["Draft.md", "Shot.md", "shot-1.png"]);
  });

  function post(path: string, body: unknown): Promise<Response> {
    return handleRequest(
      new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) }),
      ctx,
    );
  }
});
