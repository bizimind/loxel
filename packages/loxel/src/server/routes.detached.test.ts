import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
      sendToActiveWindow: () => false,
      sendToWorktreeWindows: () => {},
      externalFolderConflict: () => null,
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
      setTerminalCommand: () => {},
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

  test("file content of a deleted draft is a 404 with code ENOENT", async () => {
    const draft = join(detachedDir, "Draft.md");
    ctx.resolveFilePath = (absolutePath) =>
      absolutePath === draft
        ? {
            type: "detached",
            wtPath: wt,
            resources: { detachedFilesService: service } as never,
            name: "Draft.md",
          }
        : null;

    const present = await get(
      `/api/file-content?path=${encodeURIComponent(draft)}&wt=${encodeURIComponent(wt)}`,
    );
    expect(await present.json()).toEqual({ content: "draft" });

    await rm(draft);
    const missing = await get(
      `/api/file-content?path=${encodeURIComponent(draft)}&wt=${encodeURIComponent(wt)}`,
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "File not found", code: "ENOENT" });
  });

  test("file content for an unresolved path is a 404 without a code", async () => {
    const res = await get(
      `/api/file-content?path=${encodeURIComponent(join(root, "elsewhere.md"))}`,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "File not found in any active worktree" });
  });

  function get(path: string): Promise<Response> {
    return handleRequest(new Request(`http://localhost${path}`), ctx);
  }

  function post(path: string, body: unknown): Promise<Response> {
    return handleRequest(
      new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) }),
      ctx,
    );
  }
});
