import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileOperationsHistory, FileOperationsService } from "./file-operations-service";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fos-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function seedRepo(): Promise<string> {
  const repo = tempDir();
  await Bun.$`git init -q -b main ${repo}`.quiet();
  await Bun.write(path.join(repo, "folder", "a.txt"), "a\n");
  await Bun.$`git -C ${repo} add -A`.quiet();
  await Bun.$`git -C ${repo} -c user.email=t@t -c user.name=t commit -q -m init`.quiet();
  return repo;
}

describe("FileOperationsService with git disabled", () => {
  test("renames and deletes tracked files without touching the enclosing repo's index", async () => {
    const repo = await seedRepo();
    const folder = path.join(repo, "folder");
    const service = new FileOperationsService(folder, { git: false });

    await service.rename("a.txt", "b.txt");
    expect(existsSync(path.join(folder, "b.txt"))).toBe(true);
    expect(await Bun.$`git -C ${repo} diff --cached --name-only`.text()).toBe("");

    await service.delete("b.txt");
    expect(existsSync(path.join(folder, "b.txt"))).toBe(false);
    expect(await Bun.$`git -C ${repo} diff --cached --name-only`.text()).toBe("");

    await service.undo();
    expect(await Bun.file(path.join(folder, "b.txt")).text()).toBe("a\n");
    expect(await Bun.$`git -C ${repo} diff --cached --name-only`.text()).toBe("");
  });
});

describe("FileOperationsHistory", () => {
  function setup() {
    const history = new FileOperationsHistory();
    const firstDir = tempDir();
    const secondDir = tempDir();
    const first = new FileOperationsService(firstDir, { git: false, history });
    const second = new FileOperationsService(secondDir, { git: false, history });
    return { history, first, second, firstDir, secondDir };
  }

  test("undoes and redoes the most recent operation across services", async () => {
    const { history, first, second, firstDir, secondDir } = setup();
    await first.createFile("", "one.md");
    await second.createFile("", "two.md");

    const undone = await history.undo();
    expect(undone?.service).toBe(second);
    expect(existsSync(path.join(secondDir, "two.md"))).toBe(false);
    expect(existsSync(path.join(firstDir, "one.md"))).toBe(true);

    expect((await history.undo())?.service).toBe(first);
    expect(await history.undo()).toBeNull();

    expect((await history.redo())?.service).toBe(first);
    expect((await history.redo())?.service).toBe(second);
    expect(existsSync(path.join(secondDir, "two.md"))).toBe(true);
    expect(await history.redo()).toBeNull();
  });

  test("a new operation clears redo everywhere", async () => {
    const { history, first, second } = setup();
    await first.createFile("", "one.md");
    await history.undo();

    await second.createDir("", "dir");

    expect(await history.redo()).toBeNull();
  });

  test("a move into the item's own folder adds no undo step", async () => {
    const { history, first, second, firstDir } = setup();
    await first.createFile("", "a.txt");
    await second.createFile("", "p.txt");

    await first.move("a.txt", "");
    const step = await history.undo();

    expect(step?.service).toBe(second);
    expect(existsSync(path.join(firstDir, "a.txt"))).toBe(true);
  });

  test("skips services that were disposed", async () => {
    const { history, first, second, firstDir } = setup();
    await first.createFile("", "one.md");
    await second.createFile("", "two.md");
    second.dispose();

    const step = await history.undo();

    expect(step?.service).toBe(first);
    expect(existsSync(path.join(firstDir, "one.md"))).toBe(false);
  });
});
