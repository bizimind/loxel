import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { updateResourceDirs } from "./update-resource-dirs";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "update-resource-dirs-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("updateResourceDirs", () => {
  test("lists the directories an earlier update installed, not its files or links", async () => {
    for (const dir of ["renderer", "jdtls", "clangd-resource", "tsgo-lib"]) {
      await mkdir(join(root, dir));
    }
    await writeFile(join(root, "loxel-server"), "");
    await symlink(join(root, "jdtls"), join(root, "linked"));
    expect(updateResourceDirs(root).toSorted()).toEqual([
      "clangd-resource",
      "jdtls",
      "renderer",
      "tsgo-lib",
    ]);
  });

  test("is empty before the first update", () => {
    expect(updateResourceDirs(join(root, "missing"))).toEqual([]);
  });
});
