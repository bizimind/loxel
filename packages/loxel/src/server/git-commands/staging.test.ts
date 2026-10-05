import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { stat, utimes } from "node:fs/promises";

import { $ } from "bun";

import { revertToHead } from "./staging";
import type { TempRepo } from "./test-utils";
import { commit, createRepo, deleteFile, renameFile, stageFile, writeFile } from "./test-utils";

let template: TempRepo;
let repo: TempRepo;

beforeAll(async () => {
  template = await createRepo();
  await commit(template.path, "init", {
    "modified.txt": "original\n",
    "deleted.txt": "deleted\n",
    "renamed.txt": "renamed\n",
    "untouched.txt": "untouched\n",
    "src/tracked.txt": "tracked\n",
    "lit/[t].txt": "literal\n",
    "lit/t.txt": "plain\n",
  });
});

afterAll(() => template.cleanup());

beforeEach(async () => {
  repo = await template.copy();
});

afterEach(() => repo.cleanup());

async function status(): Promise<string> {
  return (await $`git -C ${repo.path} status --porcelain`.text()).trimEnd();
}

async function read(file: string): Promise<string> {
  return Bun.file(`${repo.path}/${file}`).text();
}

describe("revertToHead", () => {
  test("restores staged and unstaged modifications to HEAD", async () => {
    await writeFile(repo.path, "modified.txt", "staged\n");
    await stageFile(repo.path, "modified.txt");
    await writeFile(repo.path, "modified.txt", "unstaged\n");

    await revertToHead(repo.path, ["modified.txt"]);

    expect(await status()).toBe("");
    expect(await read("modified.txt")).toBe("original\n");
  });

  test("restores a deleted file", async () => {
    await deleteFile(repo.path, "deleted.txt");

    await revertToHead(repo.path, ["deleted.txt"]);

    expect(await status()).toBe("");
    expect(await read("deleted.txt")).toBe("deleted\n");
  });

  test("undoes a staged rename given both paths", async () => {
    await renameFile(repo.path, "renamed.txt", "moved.txt");

    await revertToHead(repo.path, ["renamed.txt", "moved.txt"]);

    expect(await status()).toBe("");
    expect(await Bun.file(`${repo.path}/moved.txt`).exists()).toBe(false);
  });

  test("deletes staged new files and untracked files", async () => {
    await writeFile(repo.path, "staged-new.txt", "new\n");
    await stageFile(repo.path, "staged-new.txt");
    await writeFile(repo.path, "untracked.txt", "new\n");

    await revertToHead(repo.path, ["staged-new.txt", "untracked.txt"]);

    expect(await status()).toBe("");
    expect(await Bun.file(`${repo.path}/staged-new.txt`).exists()).toBe(false);
    expect(await Bun.file(`${repo.path}/untracked.txt`).exists()).toBe(false);
  });

  test("leaves other changes alone", async () => {
    await writeFile(repo.path, "modified.txt", "changed\n");
    await writeFile(repo.path, "untouched.txt", "changed\n");
    await writeFile(repo.path, "untracked.txt", "new\n");

    await revertToHead(repo.path, ["modified.txt"]);

    expect(await status()).toBe(" M untouched.txt\n?? untracked.txt");
  });

  test("treats paths literally rather than as globs", async () => {
    await writeFile(repo.path, "src/[g].txt", "new\n");
    await writeFile(repo.path, "src/g.txt", "new\n");

    await revertToHead(repo.path, ["src/[g].txt"]);

    expect(await status()).toBe("?? src/g.txt");
  });

  test("restores tracked files literally rather than as globs", async () => {
    await writeFile(repo.path, "lit/[t].txt", "changed\n");
    await writeFile(repo.path, "lit/t.txt", "changed\n");

    await revertToHead(repo.path, ["lit/[t].txt"]);

    expect(await status()).toBe(" M lit/t.txt");
  });

  test("skips paths that already match HEAD instead of failing", async () => {
    await writeFile(repo.path, "modified.txt", "changed\n");

    await revertToHead(repo.path, ["gone.txt", "untouched.txt", "modified.txt"]);

    expect(await status()).toBe("");
  });

  test("writes nothing in the git dir when no path needs reverting", async () => {
    // Same content, new mtime: a plain `git status` would refresh the index for this file.
    const later = new Date(Date.now() + 10_000);
    await utimes(`${repo.path}/untouched.txt`, later, later);
    const index = `${repo.path}/.git/index`;
    const before = (await stat(index)).mtimeMs;

    await revertToHead(repo.path, ["gone.txt"]);

    expect((await stat(index)).mtimeMs).toBe(before);
  });
});
