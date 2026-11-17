import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  manifestFile,
  manifestVersion,
  parseManifest,
  pinnedGoModuleVersion,
} from "./language-server-manifest";

describe("pinnedGoModuleVersion", () => {
  test.each([
    ["gopls", "gopls-module", "golang.org/x/tools/gopls"],
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

describe("pinned downloads", () => {
  const manifest = {
    script: "download-x.ts",
    resources: ["x"],
    version: "1.2.3",
    purl: "pkg:github/o/x@v{version}",
    license: "MIT",
  };

  test("a manifest's must be a URL template with hex SHA256s", () => {
    const pinned = {
      download: "https://example.com/{version}/x-{target}",
      sha256: { a: "0".repeat(64) },
    };
    expect(() => parseManifest("x", "x.json", { ...manifest, ...pinned })).not.toThrow();
    expect(() =>
      parseManifest("x", "x.json", { ...manifest, ...pinned, sha256: { a: "ABC" } }),
    ).toThrow('"sha256" of a');
    expect(() => parseManifest("x", "x.json", { ...manifest, sha256: pinned.sha256 })).toThrow(
      'needs "download"',
    );
  });

  test("manifestFile fills in the version and target", async () => {
    const version = await manifestVersion("ruff");
    const { url, sha256 } = await manifestFile("ruff", "aarch64-apple-darwin.tar.gz");
    expect(url).toBe(
      `https://github.com/astral-sh/ruff/releases/download/${version}/ruff-aarch64-apple-darwin.tar.gz`,
    );
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(manifestFile("ruff", "riscv64gc-unknown-linux-gnu.tar.gz")).rejects.toThrow(
      "run `pnpm -C packages/loxel run pin-hashes ruff`",
    );
  });
});
