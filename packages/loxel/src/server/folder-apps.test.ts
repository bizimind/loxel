import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listFolderApps } from "./folder-apps";

let root: string;
let system: string;
let user: string;
let utilities: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "folder-apps-"));
  system = join(root, "Applications");
  user = join(root, "home", "Applications");
  utilities = join(root, "Utilities");
  for (const app of [
    join(system, "Zed.app"),
    join(system, "Ghostty.app"),
    join(system, "Finder.app"),
    join(user, "PyCharm.app"),
    join(user, "Zed.app"),
    join(utilities, "Terminal.app"),
  ]) {
    await mkdir(app, { recursive: true });
  }
  // A file named like an app is not an app bundle
  await Bun.write(join(system, "Cursor.app"), "");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("listFolderApps", () => {
  test("lists installed curated apps, terminals first, first install location wins", async () => {
    expect(await listFolderApps([system, user, utilities])).toEqual([
      { path: join(utilities, "Terminal.app"), name: "Terminal", group: "terminal" },
      { path: join(system, "Ghostty.app"), name: "Ghostty", group: "terminal" },
      { path: join(system, "Zed.app"), name: "Zed", group: "editor" },
      { path: join(user, "PyCharm.app"), name: "PyCharm", group: "editor" },
    ]);
  });

  test("returns nothing when no curated app is installed", async () => {
    expect(await listFolderApps([join(root, "missing")])).toEqual([]);
  });
});
