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
  let homeDrafts: DetachedFilesService;
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
    homeDrafts = new DetachedFilesService(join(root, "home-drafts"), () => {});
    await homeDrafts.start();

    const resources = { detachedFilesService: service } as WorktreeResources;

    ctx = {
      broadcastToSubscribers: () => {},
      broadcastToProject: () => {},
      broadcastAll: () => {},
      sendToActiveWindow: () => false,
      sendToWorktreeWindows: () => false,
      externalFolderConflict: () => null,
      getProject: () => undefined,
      findProjectForPath: () => undefined,
      getWorktreeResources: (path) => (path === wt ? resources : undefined),
      suspendWorktreeWatchers: async () => async () => {},
      completeWorktreeRemoval: () => {},
      resolveFilePath: () => null,
      initializeProject: async () => ({ project: {} as never, worktrees: [] }),
      teardownProject: () => {},
      isShuttingDown: () => false,
      resolveSchema: async () => ({}),
      schemaConsent: {} as never,
      ensureSchemas: async () => {},
      updateYamlSchemas: () => {},
      updateTomlSchemas: () => {},
      formatContent: async () => ({ content: null }),
      getDetectedFormatters: () => [],
      activeWindow: () => null,
      homeDrafts,
      startTerminal: async () => {},
      listTerminals: async () => ({ terminals: [] }),
    };
  });

  afterEach(async () => {
    service.stop();
    homeDrafts.stop();
    await rm(root, { recursive: true, force: true });
  });

  test("Home's drafts are created, listed, read, renamed and deleted under the Home key", async () => {
    const created = await post("/api/detached-file-create", {
      wt: "home",
      prefix: "Note",
      ext: "md",
    });
    expect(created.status).toBe(200);
    const { name, path } = (await created.json()) as { name: string; path: string };
    expect(path).toBe(join(root, "home-drafts", name));

    const listed = await get(`/api/detached-files?wt=home`);
    expect(((await listed.json()) as { name: string }[]).map((e) => e.name)).toEqual([name]);
    const read = await get(`/api/detached-file-content?wt=home&name=${name}`);
    expect(read.status).toBe(200);

    const renamed = await post("/api/detached-file-rename", {
      wt: "home",
      path,
      newName: "Plan.md",
    });
    expect(((await renamed.json()) as { path: string }).path).toBe(
      join(root, "home-drafts", "Plan.md"),
    );
    const deleted = await post("/api/detached-file-delete", { wt: "home", name: "Plan.md" });
    expect(deleted.status).toBe(200);
  });

  test("Home's drafts can't move or copy into a project, which they have none of", async () => {
    for (const route of ["/api/detached-file-move", "/api/detached-file-copy-to-project"]) {
      const res = await post(route, { wt: "home", name: "Draft.md", destPath: "src" });
      expect(res.status).toBe(400);
    }
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

  test("move copies (not moves) images another draft still references", async () => {
    await writeFile(join(detachedDir, "A.md"), "![s](./shared.png) ![o](./own.png)");
    await writeFile(join(detachedDir, "B.md"), "![s](./shared.png)");
    await writeFile(join(detachedDir, "shared.png"), "png");
    await writeFile(join(detachedDir, "own.png"), "png");

    const res = await post("/api/detached-file-move", {
      wt,
      path: join(detachedDir, "A.md"),
      destPath: "src",
    });

    expect(res.status).toBe(200);
    expect((await readdir(join(wt, "src"))).sort()).toEqual(["A.md", "own.png", "shared.png"]);
    expect((await readdir(detachedDir)).sort()).toEqual(["B.md", "Draft.md", "shared.png"]);
  });

  test("move ignores non-image files referenced with image syntax", async () => {
    await writeFile(join(detachedDir, "Note.md"), "![x](./todo.md) ![y](./secrets.txt)");
    await writeFile(join(detachedDir, "todo.md"), "todo");
    await writeFile(join(detachedDir, "secrets.txt"), "s");

    const res = await post("/api/detached-file-move", {
      wt,
      path: join(detachedDir, "Note.md"),
      destPath: "src",
    });

    expect(res.status).toBe(200);
    expect(await readdir(join(wt, "src"))).toEqual(["Note.md"]);
    expect((await readdir(detachedDir)).sort()).toEqual(["Draft.md", "secrets.txt", "todo.md"]);
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

  test("file content of a deleted draft is a 404 with code ENOENT", async () => {
    const draft = join(detachedDir, "Draft.md");
    ctx.resolveFilePath = (absolutePath) =>
      absolutePath === draft ? { type: "detached", wtPath: wt, service, name: "Draft.md" } : null;

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
