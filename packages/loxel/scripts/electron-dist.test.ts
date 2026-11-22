import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ELECTRON_ARCHES,
  PATCHES_DIR,
  buildId,
  currentBuild,
  distZipName,
  electronVersion,
  objectKey,
  parseArch,
  patchDocName,
  pinSha256,
  pinnedSha256,
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

  test("refuses two patches with the same number", () => {
    withDir({ "0001-a.patch": "one", "0001-b.patch": "two" }, (dir) =>
      expect(() => readPatches(dir)).toThrow("0001-a.patch, 0001-b.patch"),
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

test("this checkout pins the SHA-256 of its build for every architecture", () => {
  const { id } = currentBuild();
  for (const arch of ELECTRON_ARCHES) expect(pinnedSha256(id, arch)).toMatch(/^[0-9a-f]{64}$/);
});

describe("pinnedSha256", () => {
  const sha = (char: string) => char.repeat(64);
  const withFile = (run: (file: string) => void) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "loxel-builds-"));
    try {
      run(path.join(dir, "builds.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("returns what pinSha256 recorded for the build", () => {
    withFile((file) => {
      pinSha256("45.3.0-abc", "arm64", sha("a"), file);
      pinSha256("45.3.0-abc", "x64", sha("b"), file);
      expect(pinnedSha256("45.3.0-abc", "arm64", file)).toBe(sha("a"));
      expect(pinnedSha256("45.3.0-abc", "x64", file)).toBe(sha("b"));
    });
  });

  test("refuses another build, a missing architecture or no file", () => {
    withFile((file) => {
      expect(() => pinnedSha256("45.3.0-abc", "arm64", file)).toThrow(/pins no SHA-256/);
      pinSha256("45.3.0-abc", "arm64", sha("a"), file);
      expect(() => pinnedSha256("45.3.0-def", "arm64", file)).toThrow(/pins no SHA-256/);
      expect(() => pinnedSha256("45.3.0-abc", "x64", file)).toThrow(/pins no SHA-256/);
    });
  });

  test("a new build replaces the pins of the old one", () => {
    withFile((file) => {
      pinSha256("45.3.0-abc", "arm64", sha("a"), file);
      pinSha256("45.3.0-abc", "x64", sha("b"), file);
      pinSha256("45.3.1-def", "arm64", sha("c"), file);
      expect(pinnedSha256("45.3.1-def", "arm64", file)).toBe(sha("c"));
      expect(() => pinnedSha256("45.3.1-def", "x64", file)).toThrow(/pins no SHA-256/);
      expect(() => pinnedSha256("45.3.0-abc", "arm64", file)).toThrow(/pins no SHA-256/);
    });
  });
});

test("r2Client names the credentials it is missing", () => {
  expect(() => r2Client({ R2_PRIVATE_ACCESS_KEY_ID: "id" })).toThrow(
    /R2_PRIVATE_SECRET_ACCESS_KEY, CLOUDFLARE_ACCOUNT_ID/,
  );
});
