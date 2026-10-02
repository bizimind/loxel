import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import type { WsMessage } from "@/api/ws-protocol";

import { ExternalFilesService } from "./external-files-service";
import { ExternalFoldersService } from "./external-folders-service";
import { FileOperationsHistory, FileOperationsService } from "./file-operations-service";
import { ProjectFilesService } from "./project-files-service";
import type { RouteContext } from "./routes";
import { handleRequest } from "./routes";
import type { ProjectState, ResolvedFilePath, WorktreeResources } from "./server-state";
import { externalFolderConflict } from "./server-state";

describe("Others folders routes", () => {
  let root: string;
  let wt: string;
  let folder: string;
  let resources: WorktreeResources;
  let ctx: RouteContext;
  let sent: Array<{ wtPath: string | null; msg: WsMessage }>;
  let windowConnected: boolean;

  beforeEach(async () => {
    root = realpathSync(await mkdtemp(join(tmpdir(), "loxel-others-")));
    wt = join(root, "project");
    folder = join(root, "notes");
    await mkdir(join(wt, "src"), { recursive: true });
    await mkdir(join(folder, "sub"), { recursive: true });
    await writeFile(join(folder, "a.md"), "a");
    await writeFile(join(folder, "sub", "b.md"), "b");

    const fileOpsHistory = new FileOperationsHistory();
    const externalFoldersService = new ExternalFoldersService({
      storage: { load: () => [], save: () => {} },
      conflict: () => null,
      history: fileOpsHistory,
      onListChanged: () => {},
      onDirChanged: () => {},
      onFileChanged: () => {},
    });
    const externalFilesService = new ExternalFilesService(
      () => {},
      () => {},
    );
    externalFilesService.start();
    const filesService = new ProjectFilesService(wt, () => {}, undefined, undefined, {
      gitStatus: false,
    });
    await filesService.start();
    resources = {
      projectPath: wt,
      worktreeWatcher: null,
      filesService,
      fileOpsService: new FileOperationsService(wt, { git: false, history: fileOpsHistory }),
      fileOpsHistory,
      detachedFilesService: {} as WorktreeResources["detachedFilesService"],
      externalFilesService,
      externalFoldersService,
      subscribers: new Set(),
    };

    sent = [];
    windowConnected = true;
    const project = { cwd: wt, worktreesDir: join(wt, ".worktrees") } as ProjectState;
    ctx = {
      broadcastToSubscribers: () => {},
      broadcastToProject: () => {},
      broadcastAll: () => {},
      sendToActiveWindow: (wtPath, msg) => {
        sent.push({ wtPath, msg });
        return windowConnected;
      },
      externalFolderConflict: (path) => externalFolderConflict([project], path, "/home/me"),
      getProject: () => undefined,
      findProjectForPath: (path) =>
        path === wt || path.startsWith(wt + "/") ? project : undefined,
      getWorktreeResources: (path) => (path === wt ? resources : undefined),
      suspendWorktreeWatchers: async () => async () => {},
      completeWorktreeRemoval: () => {},
      resolveFilePath: (path): ResolvedFilePath | null => {
        if (path.startsWith(wt + "/")) {
          return {
            type: "project",
            wtPath: wt,
            resources,
            relativePath: path.slice(wt.length + 1),
          };
        }
        const owner = externalFoldersService.find(path);
        if (owner) {
          const relativePath = relative(owner.root, path);
          return { type: "external-folder", wtPath: wt, resources, folder: owner, relativePath };
        }
        return null;
      },
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
    resources.filesService.stop();
    resources.externalFilesService.stop();
    resources.externalFoldersService.stop();
    await rm(root, { recursive: true, force: true });
  });

  describe("POST /api/external-folders/add", () => {
    test("opens a folder and lists it before individually opened files", async () => {
      const outsideFile = join(root, "loose.md");
      await writeFile(outsideFile, "x");
      resources.externalFilesService.addFile(outsideFile);

      const res = await post("/api/external-folders/add", { wt, path: folder });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ root: folder });
      const others = await (await get(`/api/external-files?wt=${encodeURIComponent(wt)}`)).json();
      expect(others).toEqual([
        { name: "notes", path: folder, isDir: true, status: "normal" },
        { name: "loose.md", path: outsideFile, isDir: false, status: "normal" },
      ]);
    });

    test("stops tracking open files the folder now contains", async () => {
      resources.externalFilesService.addFile(join(folder, "a.md"));

      await post("/api/external-folders/add", { wt, path: folder });

      expect(resources.externalFilesService.listFiles()).toEqual([]);
    });

    test("rejects a folder inside a project", async () => {
      const res = await post("/api/external-folders/add", { wt, path: join(wt, "src") });
      expect(res.status).toBe(409);
    });

    test("rejects a folder containing a project", async () => {
      const res = await post("/api/external-folders/add", { wt, path: root });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: `${root} contains the project at ${wt}` });
    });

    test("resolves symlinks to the real folder", async () => {
      const link = join(root, "notes-link");
      await symlink(folder, link);

      const res = await post("/api/external-folders/add", { wt, path: link });

      expect(await res.json()).toEqual({ root: folder });
    });

    test("rejects missing paths and files", async () => {
      expect(
        (await post("/api/external-folders/add", { wt, path: join(root, "nope") })).status,
      ).toBe(404);
      expect(
        (await post("/api/external-folders/add", { wt, path: join(folder, "a.md") })).status,
      ).toBe(400);
    });
  });

  test("POST /api/external-folders/remove closes the folder", async () => {
    await post("/api/external-folders/add", { wt, path: folder });

    const res = await post("/api/external-folders/remove", { wt, path: folder });

    expect(await res.json()).toEqual({ removed: true });
    expect(resources.externalFoldersService.list()).toEqual([]);
  });

  test("GET /api/files lists a folder's root and subdirectories", async () => {
    await post("/api/external-folders/add", { wt, path: folder });

    const rootEntries = await (await get(filesUrl(folder))).json();
    const subEntries = await (await get(filesUrl(join(folder, "sub")))).json();

    expect(rootEntries.map((e: { name: string }) => e.name)).toEqual(["sub", "a.md"]);
    expect(subEntries).toEqual([
      { name: "b.md", path: join(folder, "sub", "b.md"), isDir: false, status: "normal" },
    ]);
  });

  test("file content and writes resolve inside a folder", async () => {
    await post("/api/external-folders/add", { wt, path: folder });
    const file = join(folder, "sub", "b.md");

    const write = await post("/api/file-write", { path: file, content: "new", nonce: "n1" });
    const read = await get(`/api/file-content?path=${encodeURIComponent(file)}`);

    expect(write.status).toBe(200);
    expect(await read.json()).toEqual({ content: "new" });
  });

  describe("file operations", () => {
    beforeEach(async () => {
      await post("/api/external-folders/add", { wt, path: folder });
    });

    test("create and undo act on the folder and report absolute paths", async () => {
      const created = await post("/api/files/create-file", { wt, dir: folder, name: "c.md" });
      expect(await created.json()).toEqual({ path: join(folder, "c.md") });
      expect(existsSync(join(folder, "c.md"))).toBe(true);

      const undone = await post("/api/files/undo", { wt });

      expect(await undone.json()).toEqual({
        result: { type: "delete", path: join(folder, "c.md") },
      });
      expect(existsSync(join(folder, "c.md"))).toBe(false);
    });

    test("undo follows operations across the worktree and its folders", async () => {
      await post("/api/files/create-file", { wt, dir: folder, name: "c.md" });
      await post("/api/files/create-file", { wt, dir: "src", name: "d.ts" });

      const undone = await post("/api/files/undo", { wt });

      expect(await undone.json()).toEqual({ result: { type: "delete", path: "src/d.ts" } });
      expect(existsSync(join(folder, "c.md"))).toBe(true);
    });

    test("rejects moving a file from a folder into the worktree", async () => {
      const res = await post("/api/files/move", {
        wt,
        srcPath: join(folder, "a.md"),
        destDir: join(wt, "src"),
      });

      expect(res.status).toBe(400);
      expect(existsSync(join(folder, "a.md"))).toBe(true);
    });
  });

  describe("POST /api/open with a folder", () => {
    test("sends the folder to the window in use", async () => {
      const res = await post("/api/open", { filePath: folder, wtPath: wt });

      expect(res.status).toBe(200);
      expect(sent).toEqual([{ wtPath: wt, msg: { type: "open_folder", data: { path: folder } } }]);
    });

    test("needs no worktree", async () => {
      await post("/api/open", { filePath: folder });

      expect(sent).toEqual([
        { wtPath: null, msg: { type: "open_folder", data: { path: folder } } },
      ]);
    });

    test("reports when no window is open", async () => {
      windowConnected = false;

      const res = await post("/api/open", { filePath: folder });

      expect(res.status).toBe(503);
    });
  });

  test("GET /api/path-info reports directories", async () => {
    const dir = await (await get(`/api/path-info?path=${encodeURIComponent(folder)}`)).json();
    const file = await (
      await get(`/api/path-info?path=${encodeURIComponent(join(folder, "a.md"))}`)
    ).json();
    const missing = await get(`/api/path-info?path=${encodeURIComponent(join(root, "nope"))}`);

    expect(dir).toEqual({ path: folder, isDir: true });
    expect(file).toEqual({ path: join(folder, "a.md"), isDir: false });
    expect(missing.status).toBe(404);
  });

  function filesUrl(dir: string): string {
    return `/api/files?wt=${encodeURIComponent(wt)}&dir=${encodeURIComponent(dir)}`;
  }

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
