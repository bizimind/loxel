import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  MANIFEST_DIR,
  manifestSha256,
  manifestVersion,
  parseManifest,
  pinnedGoModuleVersion,
  readAllManifests,
} from "./language-server-manifest";

describe("pinnedGoModuleVersion", () => {
  test.each([
    ["gopls", "gopls-module", "golang.org/x/tools/gopls"],
    ["docker-language-server", "docker-lsp-module", "github.com/docker/docker-language-server"],
    ["terraform-ls", "terraform-ls-module", "github.com/hashicorp/terraform-ls"],
  ])("%s's pinned go.mod requires its manifest's version", async (name, dir, modulePath) => {
    const version = await pinnedGoModuleVersion(name, path.join(import.meta.dir, dir), modulePath);
    expect(version).toBe(`v${await manifestVersion(name)}`);
  });

  test("throws when the manifest names another version", async () => {
    const goplsModule = path.join(import.meta.dir, "gopls-module");
    await expect(
      pinnedGoModuleVersion("terraform-ls", goplsModule, "golang.org/x/tools/gopls"),
    ).rejects.toThrow("but terraform-ls.json says");
  });
});

describe("sha256 pins", () => {
  const digest = "a".repeat(64);
  const manifest = (purl: string, sha256: Record<string, string>) => ({
    script: "download-x.ts",
    resources: ["x"],
    version: "1.2.3",
    purl,
    license: "MIT",
    sha256,
  });

  test("are keyed by the release tag the purl names and a target", () => {
    const parsed = parseManifest(
      "x",
      "x.json",
      manifest("pkg:github/o/x@v{version}", { "v1.2.3/linux": digest }),
    );
    expect("sha256" in parsed && parsed.sha256).toEqual({ "v1.2.3/linux": digest });
  });

  test.each([
    ["another release's tag", "pkg:github/o/x@v{version}", "v1.2.2/linux"],
    ["the version without the tag's prefix", "pkg:github/o/x@v{version}", "1.2.3/linux"],
    ["no target", "pkg:github/o/x@{version}", "1.2.3/"],
    ["a target with a slash", "pkg:github/o/x@{version}", "1.2.3/linux/x64"],
    ["a release tag with a slash", "pkg:github/o/x@release%2F{version}", "release/1.2.3/linux"],
    ["a purl that is not GitHub's", "pkg:golang/example.com/x@v{version}", "v1.2.3/linux"],
  ])("reject %s", (_, purl, key) => {
    expect(() => parseManifest("x", "x.json", manifest(purl, { [key]: digest }))).toThrow(
      "x.json:",
    );
  });

  test("manifestSha256 reads a manifest's pin for a target", async () => {
    const version = await manifestVersion("ruff");
    const parsed = await Bun.file(path.join(import.meta.dir, "language-servers/ruff.json")).json();
    expect(await manifestSha256("ruff", "aarch64-apple-darwin")).toBe(
      parsed.sha256[`${version}/aarch64-apple-darwin`],
    );
    await expect(manifestSha256("ruff", "riscv64gc-unknown-linux-gnu")).rejects.toThrow(
      "ruff.json pins no SHA256",
    );
  });
});

// Renovate (renovate.json) bumps `version` by replacing the first occurrence of its text.
test("every manifest's version text first appears in its version field", async () => {
  const field = '"version": "';
  for (const manifest of await readAllManifests()) {
    if (!("version" in manifest)) continue;
    const raw = await Bun.file(path.join(MANIFEST_DIR, `${manifest.name}.json`)).text();
    const fieldStart = raw.indexOf(`${field}${manifest.version}"`) + field.length;
    expect({ name: manifest.name, first: raw.indexOf(manifest.version) }).toEqual({
      name: manifest.name,
      first: fieldStart,
    });
  }
});
