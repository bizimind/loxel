import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeExecutable } from "@/test/executable";

import { runsThroughVersionManager, shimEntry } from "./version-manager-link";

const root = await realpath(await mkdtemp(join(tmpdir(), "version-manager-link-")));
afterAll(() => rm(root, { recursive: true, force: true }));

describe("runsThroughVersionManager and shimEntry", () => {
  test("a script in a shims directory runs by its own path", async () => {
    const shim = await writeExecutable(join(root, "asdf", "shims", "python3"));
    expect(runsThroughVersionManager(shim)).toBe(true);
    expect(shimEntry(shim)).toBe(shim);
  });

  test("a link to mise runs by the link, since mise reads the name it was started by", async () => {
    const mise = await writeExecutable(join(root, "mise-bin", "mise"));
    const shim = join(root, "mise", "shims", "python3");
    await mkdir(join(root, "mise", "shims"), { recursive: true });
    await symlink(mise, shim);
    const link = join(root, "bin", "python3");
    await mkdir(join(root, "bin"));
    await symlink(shim, link);
    expect(runsThroughVersionManager(link)).toBe(true);
    expect(shimEntry(link)).toBe(shim);
  });

  test("a link through a shims directory counts, wherever it ends", async () => {
    const target = await writeExecutable(join(root, "proto", "bin", "proto-shim"));
    const shim = join(root, "proto", "shims", "python3");
    await mkdir(join(root, "proto", "shims"));
    await symlink(target, shim);
    const link = join(root, "local", "python3");
    await mkdir(join(root, "local"));
    await symlink(shim, link);
    expect(runsThroughVersionManager(link)).toBe(true);
  });

  test("an interpreter outside any shims directory does not", async () => {
    const python = await writeExecutable(join(root, "usr", "bin", "python3.12"));
    const link = join(root, "usr", "bin", "python3");
    await symlink(python, link);
    expect(runsThroughVersionManager(link)).toBe(false);
  });
});
