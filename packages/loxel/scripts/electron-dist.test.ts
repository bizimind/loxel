import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PATCHES_DIR,
  buildId,
  currentBuild,
  distZipName,
  electronVersion,
  objectKey,
  parseArch,
  patchDocName,
  r2Client,
  readPatches,
} from "./electron-dist";

const patch = (name: string, text: string) => ({ name, contents: new TextEncoder().encode(text) });

describe("electronVersion", () => {
  test("reads the exact pin", () => {
    expect(electronVersion({ devDependencies: { electron: "45.3.0" } })).toBe("45.3.0");
  });

  test("refuses a range or a missing pin", () => {
    expect(() => electronVersion({ devDependencies: { electron: "^45.3.0" } })).toThrow();
    expect(() => electronVersion({ devDependencies: {} })).toThrow();
    expect(() => electronVersion(null)).toThrow();
  });
});

describe("buildId", () => {
  const patches = [patch("0001-a.patch", "one"), patch("0002-b.patch", "two")];

  test("is the version plus a stable digest of the patches", () => {
    const id = buildId("45.3.0", patches);
    expect(id).toMatch(/^45\.3\.0-[0-9a-f]{16}$/);
    expect(buildId("45.3.0", [...patches])).toBe(id);
  });

  test("changes with the version, a patch's contents, name or order", () => {
    const id = buildId("45.3.0", patches);
    expect(buildId("45.3.1", patches)).not.toBe(id);
    expect(buildId("45.3.0", [patches[0]!, patch("0002-b.patch", "two!")])).not.toBe(id);
    expect(buildId("45.3.0", [patches[0]!, patch("0002-c.patch", "two")])).not.toBe(id);
    expect(buildId("45.3.0", [patches[1]!, patches[0]!])).not.toBe(id);
  });
});

test("names files the way electron-builder and the bucket expect", () => {
  expect(distZipName("45.3.0", "x64")).toBe("electron-v45.3.0-darwin-x64.zip");
  expect(objectKey("45.3.0-abc", "electron-v45.3.0-darwin-x64.zip")).toBe(
    "electron/45.3.0-abc/electron-v45.3.0-darwin-x64.zip",
  );
});

test("parseArch accepts only the architectures Loxel ships", () => {
  expect(parseArch("arm64")).toBe("arm64");
  expect(parseArch("x64")).toBe("x64");
  expect(() => parseArch("ia32")).toThrow();
});

test("this checkout pins an exact Electron and has patches to apply", () => {
  const build = currentBuild();
  expect(build.patches.length).toBeGreaterThan(0);
  expect(build.id.startsWith(`${build.version}-`)).toBe(true);
});

test("every patch in this checkout has its doc", () => {
  const undocumented = readPatches()
    .map(({ name }) => patchDocName(name))
    .filter((doc) => !existsSync(path.join(PATCHES_DIR, doc)));
  expect(undocumented).toEqual([]);
});

describe("readPatches", () => {
  const withDir = (files: Record<string, string>, run: (dir: string) => void) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "loxel-patches-"));
    try {
      for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("reads only the patches, in numeric order, so a doc changes no build ID", () => {
    withDir(
      {
        "0010-c.patch": "ten",
        "0002-b.patch": "two",
        "0002-b-patch.md": "doc",
        "0001-a.patch": "one",
      },
      (dir) => {
        expect(readPatches(dir).map(({ name }) => name)).toEqual([
          "0001-a.patch",
          "0002-b.patch",
          "0010-c.patch",
        ]);
      },
    );
  });

  test("refuses a patch without a four-digit number", () => {
    withDir({ "1-a.patch": "one" }, (dir) => expect(() => readPatches(dir)).toThrow(/1-a\.patch/));
  });
});

test("patchDocName names the doc beside a patch", () => {
  expect(patchDocName("0005-file-system-access-grants.patch")).toBe(
    "0005-file-system-access-grants-patch.md",
  );
});

test("r2Client names the credentials it is missing", () => {
  expect(() => r2Client({ R2_PRIVATE_ACCESS_KEY_ID: "id" })).toThrow(
    /R2_PRIVATE_SECRET_ACCESS_KEY, CLOUDFLARE_ACCOUNT_ID/,
  );
});
