import { describe, expect, test } from "bun:test";

import { manifestFile, manifestVersion, parseManifest } from "./language-server-manifest";

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
