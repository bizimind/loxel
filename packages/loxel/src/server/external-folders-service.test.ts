import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExternalFolderStorage } from "./external-folders-service";
import { ExternalFolderRegistry, ExternalFoldersService } from "./external-folders-service";

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
  const registry = new ExternalFolderRegistry({
    onDirChanged: () => {},
    onFileChanged: (worktrees, path) => fileEvents.push({ worktrees, path }),
  });
  return { registry, fileEvents };
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
  test("worktrees opening the same folder share one instance", async () => {
    const base = tempDir();
    const { registry } = createRegistry();
    const { service: first } = createService(memoryStorage(), undefined, registry, "/wt/a");
    const { service: second } = createService(memoryStorage(), undefined, registry, "/wt/b");

    await first.add(base);
    await second.add(base);

    expect(second.find(base)).toBe(first.find(base)!);
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

  test("keeps a folder live until the last worktree releases it", async () => {
    const base = tempDir();
    const { registry } = createRegistry();
    const { service: first } = createService(memoryStorage(), undefined, registry, "/wt/a");
    const { service: second } = createService(memoryStorage(), undefined, registry, "/wt/b");
    await first.add(base);
    await second.add(base);

    first.stop();
    expect(registry.get(base)).toBeDefined();

    second.remove(base);
    expect(registry.get(base)).toBeUndefined();
  });
});
