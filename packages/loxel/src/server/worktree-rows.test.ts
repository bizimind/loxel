import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { layoutCanonicalKey, layoutKeyWorktree, layoutSessionKey } from "@/lib/layout-key-schema";

import { getStore, listStoreKeys, deleteStore, putStore } from "./store-db";
import { toolchainStatusModules } from "./toolchain-statuses";
import {
  deleteRowsOfMissingWorktrees,
  deleteWorktreeRows,
  isLayoutRowOfMissingWorktree,
} from "./worktree-rows";

const WINDOW = "11111111-2222-3333-4444-555555555555";

function rowsOf(wtPath: string): string[] {
  return [
    layoutSessionKey(WINDOW, "outer", wtPath),
    layoutSessionKey(WINDOW, "center", wtPath),
    layoutCanonicalKey("outer", wtPath),
    layoutCanonicalKey("center", wtPath),
    `external-folders:${wtPath}`,
    ...toolchainStatusModules.map((module) => module.overrideStoreKey(wtPath)),
  ];
}

function seed(wtPath: string): string[] {
  const keys = rowsOf(wtPath);
  for (const key of keys) putStore(key, "{}");
  return keys;
}

afterEach(() => {
  for (const key of listStoreKeys()) deleteStore(key);
});

describe("layoutKeyWorktree", () => {
  test("reads the path of both key shapes, colons in it included", () => {
    expect(layoutKeyWorktree(layoutSessionKey(WINDOW, "center", "/a:b/c"))).toBe("/a:b/c");
    expect(layoutKeyWorktree(layoutCanonicalKey("outer", "/a:b/c"))).toBe("/a:b/c");
  });

  test("is null for any other key", () => {
    expect(layoutKeyWorktree("settings")).toBeNull();
    expect(layoutKeyWorktree("external-folders:/a")).toBeNull();
    expect(layoutKeyWorktree("layout:canonical:outer")).toBeNull();
  });
});

describe("deleteWorktreeRows", () => {
  test("deletes every row of the worktree and nothing else", () => {
    seed("/repo/.worktrees/a");
    const others = seed("/repo/.worktrees/a-other");
    const nested = seed("/x:/repo/.worktrees/a");
    putStore("settings", "{}");
    putStore("repo-trust:abc", "{}");

    deleteWorktreeRows("/repo/.worktrees/a");

    expect(listStoreKeys().sort()).toEqual(
      [...others, ...nested, "settings", "repo-trust:abc"].sort(),
    );
  });
});

describe("deleteRowsOfMissingWorktrees", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-rows-")));
  const worktreesDir = join(dir, ".worktrees");
  const onDisk = join(worktreesDir, "on-disk");
  mkdirSync(onDisk, { recursive: true });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("deletes only worktrees neither registered nor on disk, under the worktrees directory", () => {
    const missing = join(worktreesDir, "feat/missing");
    const registered = join(worktreesDir, "registered-but-gone");
    const outside = join(dir, "regular-root");
    seed(missing);
    const kept = [...seed(registered), ...seed(onDisk), ...seed(outside)];
    putStore(layoutCanonicalKey("outer", "default"), "{}");

    const deleted = deleteRowsOfMissingWorktrees(worktreesDir, new Set([registered]));

    expect(deleted).toEqual([missing]);
    expect(listStoreKeys().sort()).toEqual(
      [...kept, layoutCanonicalKey("outer", "default")].sort(),
    );
  });
});

test("deleteRowsOfMissingWorktrees decides nothing when the worktrees directory is gone", () => {
  const keys = seed("/not/mounted/.worktrees/a");
  expect(deleteRowsOfMissingWorktrees("/not/mounted/.worktrees", new Set())).toEqual([]);
  expect(listStoreKeys().sort()).toEqual(keys.toSorted());
});

describe("isLayoutRowOfMissingWorktree", () => {
  test("is true only for the layout rows of a path that is gone", () => {
    const here = realpathSync(tmpdir());
    const gone = join(here, "loxel-no-such-worktree");
    expect(isLayoutRowOfMissingWorktree(layoutSessionKey(WINDOW, "center", gone))).toBe(true);
    expect(isLayoutRowOfMissingWorktree(layoutCanonicalKey("outer", gone))).toBe(true);
    expect(isLayoutRowOfMissingWorktree(layoutSessionKey(WINDOW, "center", here))).toBe(false);
    expect(isLayoutRowOfMissingWorktree(layoutSessionKey(WINDOW, "center", "default"))).toBe(false);
    expect(isLayoutRowOfMissingWorktree(`external-folders:${gone}`)).toBe(false);
    expect(isLayoutRowOfMissingWorktree("settings")).toBe(false);
  });
});

test("getStore finds nothing for a deleted row", () => {
  const [key] = seed("/repo/.worktrees/b");
  deleteWorktreeRows("/repo/.worktrees/b");
  expect(getStore(key!)).toBeNull();
});
