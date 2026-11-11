import { describe, expect, test } from "bun:test";

import {
  buildId,
  currentBuild,
  distZipName,
  electronVersion,
  objectKey,
  parseArch,
  r2Client,
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

test("r2Client names the credentials it is missing", () => {
  expect(() => r2Client({ R2_PRIVATE_ACCESS_KEY_ID: "id" })).toThrow(
    /R2_PRIVATE_SECRET_ACCESS_KEY, CLOUDFLARE_ACCOUNT_ID/,
  );
});
