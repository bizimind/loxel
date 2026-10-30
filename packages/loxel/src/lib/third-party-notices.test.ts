import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  collectNpmPackages,
  parseEntry,
  readEntries,
  renderNotices,
} from "../../scripts/third-party-notices";

const LOXEL = path.resolve(import.meta.dir, "..", "..");

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "third-party-notices-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writePackage(dir: string, pkg: Record<string, unknown>, license?: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  if (license !== undefined) writeFileSync(path.join(dir, "LICENSE"), license);
}

describe("the repo's own entries", () => {
  test("every language server manifest and hand-maintained entry is complete", async () => {
    const entries = await readEntries(LOXEL);
    const names = entries.map((entry) => entry.name);
    expect(names).toContain("terraform-ls");
    expect(names).toContain("monaco-lsp-client");
  });
});

describe("parseEntry", () => {
  test("rejects an entry without a license, source or license text", () => {
    expect(() => parseEntry({ name: "x", source: "u", npm: [] }, root, "x")).toThrow("license");
    expect(() => parseEntry({ name: "x", license: "MIT", npm: [] }, root, "x")).toThrow("source");
    expect(() => parseEntry({ name: "x", license: "MIT", source: "u" }, root, "x")).toThrow(
      "licenseFile or npm",
    );
    expect(() =>
      parseEntry({ name: "x", license: "MIT", source: "u", licenseFile: "no.txt" }, root, "x"),
    ).toThrow("missing license file");
  });
});

describe("readEntries", () => {
  test("rejects a language server whose source does not name the pinned version", async () => {
    const servers = path.join(root, "scripts", "language-servers");
    mkdirSync(path.join(servers, "licenses"), { recursive: true });
    writeFileSync(path.join(servers, "licenses", "x.txt"), "text");
    writeFileSync(path.join(root, "scripts", "download-x.ts"), 'const VERSION = "1.2.3";');
    writeFileSync(
      path.join(servers, "x.json"),
      JSON.stringify({
        script: "download-x.ts",
        license: "MIT",
        source: "https://example.com/tree/v1.2.2",
        licenseFile: "licenses/x.txt",
      }),
    );
    writeFileSync(
      path.join(root, "third-party.json"),
      JSON.stringify({ languageServers: "scripts/language-servers" }),
    );
    await expect(readEntries(root)).rejects.toThrow("must name the version");
  });
});

describe("collectNpmPackages", () => {
  test("walks dependencies and workspace packages, not dev dependencies", async () => {
    const product = path.join(root, "packages", "product");
    const workspace = path.join(root, "packages", "lib");
    writePackage(product, {
      dependencies: { "@repo/lib": "workspace:*", gone: "1" },
      devDependencies: { dev: "1" },
    });
    writePackage(workspace, { name: "@repo/lib", dependencies: { a: "1" } });
    mkdirSync(path.join(product, "node_modules", "@repo"), { recursive: true });
    symlinkSync(workspace, path.join(product, "node_modules", "@repo", "lib"));
    // pnpm's layout: a package's dependencies are its siblings in the store.
    const store = path.join(root, "node_modules", ".pnpm", "a@1.0.0", "node_modules");
    writePackage(
      path.join(store, "a"),
      { name: "a", version: "1.0.0", license: "MIT", dependencies: { b: "1" } },
      "a's license",
    );
    writePackage(path.join(store, "a", "vendor", "c"), {}, "c's license");
    writePackage(path.join(store, "b"), { name: "b", version: "2.0.0", license: { type: "ISC" } });
    writePackage(path.join(root, "node_modules", "dev"), { name: "dev", version: "1.0.0" });
    symlinkSync(path.join(store, "a"), path.join(root, "node_modules", "a"));

    const packages = await collectNpmPackages(product, []);

    expect(packages.map((pkg) => `${pkg.name}@${pkg.version} ${pkg.license}`)).toEqual([
      "a@1.0.0 MIT",
      "b@2.0.0 ISC",
    ]);
    expect(packages[0]?.texts).toEqual(["a's license", "vendor/c/LICENSE:\n\nc's license"]);
  });
});

describe("renderNotices", () => {
  const license = "the license text";

  test("states source availability for MPL, and groups packages sharing a license text", async () => {
    const licenseFile = path.join(root, "license.txt");
    writeFileSync(licenseFile, license);
    const notices = await renderNotices(
      root,
      [{ name: "tf", license: "MPL-2.0", source: "https://example.com/tf", licenseFile }],
      [
        { name: "a", version: "1.0.0", license: "MIT", texts: [license] },
        { name: "b", version: "1.0.0", license: "MIT", texts: [license] },
        { name: "c", version: "1.0.0", license: "MIT", texts: [] },
      ],
    );

    expect(notices).toContain("The source code of this program is available");
    expect(notices).toContain("a@1.0.0 (MIT)\nb@1.0.0 (MIT)\n\nthe license text");
    expect(notices).toContain("This package includes no license file");
    expect(notices).not.toContain(root);
  });

  test("gives no source statement for a permissive license", async () => {
    const licenseFile = path.join(root, "license.txt");
    writeFileSync(licenseFile, license);
    const notices = await renderNotices(
      root,
      [{ name: "r", license: "MIT", source: "https://example.com/r", licenseFile }],
      [],
    );
    expect(notices).not.toContain("The source code of this program is available");
  });
});
