import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExternalFolderStorage } from "./external-folders-service";
import { ExternalFolderRegistry, ExternalFoldersService } from "./external-folders-service";
import { FileOperationsHistory } from "./file-operations-service";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "efs-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function memoryStorage(initial: string[] = []): ExternalFolderStorage & { saved: string[] } {
  const storage = {
    saved: initial,
    load: () => storage.saved,
    save: (roots: string[]) => {
      storage.saved = roots;
    },
  };
  return storage;
}

function createRegistry() {
  const fileEvents: Array<{ worktrees: readonly string[]; path: string }> = [];
  const dirEvents: Array<{ worktrees: readonly string[]; dir: string }> = [];
  const registry = new ExternalFolderRegistry({
    onDirChanged: (worktrees, dir) => dirEvents.push({ worktrees, dir }),
    onFileChanged: (worktrees, path) => fileEvents.push({ worktrees, path }),
  });
  return { registry, fileEvents, dirEvents };
}

function createService(
  storage: ExternalFolderStorage,
  conflict: (root: string) => string | null = () => null,
  registry = createRegistry().registry,
  wtPath = "/wt",
) {
  let listChanges = 0;
  const service = new ExternalFoldersService({
    wtPath,
    registry,
    history: new FileOperationsHistory(),
    storage,
    conflict,
    onListChanged: () => {
      listChanges++;
    },
  });
  cleanups.push(() => service.stop());
  return { service, listChanges: () => listChanges };
}

describe("ExternalFoldersService", () => {
  test("adds a folder, lists it as a tree root and persists it", async () => {
    const base = tempDir();
    const notes = path.join(base, "notes");
    mkdirSync(notes);
    const storage = memoryStorage();
    const { service, listChanges } = createService(storage);

    expect(await service.add(notes + "/")).toBe(notes);

    expect(service.list()).toEqual([{ name: "notes", path: notes, isDir: true, status: "normal" }]);
    expect(storage.saved).toEqual([notes]);
    expect(listChanges()).toBe(1);
  });

  test("finds the folder that contains a path, but not a sibling with the same prefix", async () => {
    const base = tempDir();
    const notes = path.join(base, "notes");
    mkdirSync(notes);
    mkdirSync(path.join(base, "notes-old"));
    const { service } = createService(memoryStorage());
    await service.add(notes);

    expect(service.find(notes)?.root).toBe(notes);
    expect(service.find(path.join(notes, "a/b.md"))?.root).toBe(notes);
    expect(service.find(path.join(base, "notes-old", "c.md"))).toBeUndefined();
  });

  test("adding a folder inside an open one returns the open folder", async () => {
    const base = tempDir();
    mkdirSync(path.join(base, "sub"));
    const { service, listChanges } = createService(memoryStorage());
    await service.add(base);

    expect(await service.add(path.join(base, "sub"))).toBe(base);
    expect(service.list().map((e) => e.path)).toEqual([base]);
    expect(listChanges()).toBe(1);
  });

  test("adding a parent replaces the open folders it contains", async () => {
    const base = tempDir();
    mkdirSync(path.join(base, "a"));
    mkdirSync(path.join(base, "b"));
    const storage = memoryStorage();
    const { service } = createService(storage);
    await service.add(path.join(base, "a"));
    await service.add(path.join(base, "b"));

    await service.add(base);

    expect(service.list().map((e) => e.path)).toEqual([base]);
    expect(storage.saved).toEqual([base]);
  });

  test("removes a folder", async () => {
    const base = tempDir();
    const storage = memoryStorage();
    const { service } = createService(storage);
    await service.add(base);

    expect(service.remove(base)).toBe(true);
    expect(service.remove(base)).toBe(false);
    expect(service.list()).toEqual([]);
    expect(storage.saved).toEqual([]);
  });

  test("restores persisted folders and drops ones that no longer exist", async () => {
    const base = tempDir();
    const kept = path.join(base, "kept");
    mkdirSync(kept);
    const storage = memoryStorage([kept, path.join(base, "gone")]);
    const { service, listChanges } = createService(storage);

    await service.start();

    expect(service.list().map((e) => e.path)).toEqual([kept]);
    expect(storage.saved).toEqual([kept]);
    expect(listChanges()).toBe(0);
  });

  test("drops restored folders that can no longer be opened or are nested", async () => {
    const base = tempDir();
    mkdirSync(path.join(base, "a", "inner"), { recursive: true });
    mkdirSync(path.join(base, "project"));
    const storage = memoryStorage([
      path.join(base, "a", "inner"),
      path.join(base, "a"),
      path.join(base, "project"),
    ]);
    const { service } = createService(storage, (root) =>
      root.endsWith("project") ? "belongs to a project" : null,
    );

    await service.start();

    expect(service.list().map((e) => e.path)).toEqual([path.join(base, "a")]);
  });

  test("refuses to add folders after it stopped", async () => {
    const { service } = createService(memoryStorage());
    service.stop();

    await expect(service.add(tempDir())).rejects.toThrow("no longer active");
  });

  test("lists a folder's contents without git status", async () => {
    const base = tempDir();
    await Bun.write(path.join(base, "a.md"), "a");
    const { service } = createService(memoryStorage());
    await service.add(base);

    const entries = await service.find(base)!.filesService.getDirContents("");

    expect(entries).toEqual([
      { name: "a.md", path: path.join(base, "a.md"), isDir: false, status: "normal" },
    ]);
  });
});

describe("ExternalFolderRegistry", () => {
  test("worktrees opening the same folder share its listing but own their file operations", async () => {
    const base = tempDir();
    const { registry } = createRegistry();
    const { service: first } = createService(memoryStorage(), undefined, registry, "/wt/a");
    const { service: second } = createService(memoryStorage(), undefined, registry, "/wt/b");

    await first.add(base);
    await second.add(base);

    expect(second.find(base)!.filesService).toBe(first.find(base)!.filesService);
    expect(second.find(base)!.fileOpsService).not.toBe(first.find(base)!.fileOpsService);
  });

  test("undo in one worktree never undoes another worktree's operation", async () => {
    const base = tempDir();
    const { registry } = createRegistry();
    const historyA = new FileOperationsHistory();
    const historyB = new FileOperationsHistory();
    const a = new ExternalFoldersService({
      wtPath: "/wt/a",
      registry,
      history: historyA,
      storage: memoryStorage(),
      conflict: () => null,
      onListChanged: () => {},
    });
    const b = new ExternalFoldersService({
      wtPath: "/wt/b",
      registry,
      history: historyB,
      storage: memoryStorage(),
      conflict: () => null,
      onListChanged: () => {},
    });
    cleanups.push(
      () => a.stop(),
      () => b.stop(),
    );
    await a.add(base);
    await b.add(base);
    await a.find(base)!.fileOpsService.createFile("", "a.txt");
    await b.find(base)!.fileOpsService.createFile("", "b.txt");

    await historyA.undo();

    expect(existsSync(path.join(base, "a.txt"))).toBe(false);
    expect(existsSync(path.join(base, "b.txt"))).toBe(true);
  });

  test("removing a folder drops its operations from the worktree's undo history", async () => {
    const base = tempDir();
    const { registry } = createRegistry();
    const history = new FileOperationsHistory();
    const service = new ExternalFoldersService({
      wtPath: "/wt/a",
      registry,
      history,
      storage: memoryStorage(),
      conflict: () => null,
      onListChanged: () => {},
    });
    const { service: other } = createService(memoryStorage(), undefined, registry, "/wt/b");
    cleanups.push(() => service.stop());
    await service.add(base);
    await other.add(base);
    await service.find(base)!.fileOpsService.createFile("", "c.txt");

    service.remove(base);

    expect(await history.undo()).toBeNull();
    expect(existsSync(path.join(base, "c.txt"))).toBe(true);
  });

  test("a folder's changes reach every worktree that has it open", async () => {
    const base = tempDir();
    const { registry, fileEvents } = createRegistry();
    const { service: first } = createService(memoryStorage(), undefined, registry, "/wt/a");
    const { service: second } = createService(memoryStorage(), undefined, registry, "/wt/b");
    await first.add(base);
    await second.add(base);
    await first.find(base)!.filesService.getDirContents("");

    await first.find(base)!.filesService.notifyChanges(["a.md"]);

    expect(fileEvents).toContainEqual({
      worktrees: ["/wt/a", "/wt/b"],
      path: path.join(base, "a.md"),
    });
  });

  test("keeps a folder's watcher live until the last worktree releases it", async () => {
    const base = tempDir();
    const { registry } = createRegistry();
    const { service: first } = createService(memoryStorage(), undefined, registry, "/wt/a");
    const { service: second } = createService(memoryStorage(), undefined, registry, "/wt/b");
    await first.add(base);
    await second.add(base);
    const shared = first.find(base)!.filesService;

    first.stop();
    const whileHeld = registry.acquire(base, "/wt/c");
    expect(whileHeld.filesService).toBe(shared);
    registry.release(base, "/wt/c");

    second.remove(base);
    const afterRelease = registry.acquire(base, "/wt/c");
    expect(afterRelease.filesService).not.toBe(shared);
    registry.release(base, "/wt/c");
  });

  test("a directory stays watched until every worktree has collapsed it", async () => {
    const base = tempDir();
    mkdirSync(path.join(base, "sub"));
    const { registry, dirEvents } = createRegistry();
    const { service: first } = createService(memoryStorage(), undefined, registry, "/wt/a");
    const { service: second } = createService(memoryStorage(), undefined, registry, "/wt/b");
    await first.add(base);
    await second.add(base);
    const shared = first.find(base)!.filesService;
    await shared.getDirContents("sub", "/wt/a");
    await shared.getDirContents("sub", "/wt/b");

    shared.unwatchDir("sub", "/wt/a");
    await Bun.write(path.join(base, "sub", "new.md"), "x");
    await shared.notifyChanges(["sub/new.md"]);

    expect(dirEvents.some((e) => e.dir === path.join(base, "sub"))).toBe(true);
  });
});
