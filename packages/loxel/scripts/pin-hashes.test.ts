import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { resolvePins, withPins } from "./pin-hashes";
import type { PinnedDownload } from "./pinned-download";

const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");

/** A fetch that answers only the URLs in `responses`. */
function fakeFetch(responses: Record<string, string | object>) {
  const requested: string[] = [];
  const fetchFn = async (url: string) => {
    requested.push(url);
    const body = responses[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(typeof body === "string" ? body : JSON.stringify(body));
  };
  return { fetchFn, requested };
}

describe("resolvePins", () => {
  test("reads GitHub's stated digest of each release asset, one API call per release", async () => {
    const pinned: PinnedDownload = {
      version: "2.0.0",
      download: "https://github.com/o/x/releases/download/v{version}/x-{version}-{target}",
      sha256: { "linux.tar.gz": hex("old"), "mac.zip": hex("old") },
    };
    const { fetchFn, requested } = fakeFetch({
      "https://api.github.com/repos/o/x/releases/tags/v2.0.0": {
        assets: [
          { name: "x-2.0.0-linux.tar.gz", digest: `sha256:${hex("linux")}` },
          { name: "x-2.0.0-mac.zip", digest: `sha256:${hex("mac")}` },
        ],
      },
    });
    expect(await resolvePins(pinned, fetchFn)).toEqual({
      "linux.tar.gz": hex("linux"),
      "mac.zip": hex("mac"),
    });
    expect(requested).toHaveLength(1);
  });

  test("hashes a GitHub asset with no stated digest, and fails on a missing one", async () => {
    const pinned: PinnedDownload = {
      version: "2.0.0",
      download: "https://github.com/o/x/releases/download/{version}/x-{target}",
      sha256: { linux: hex("old") },
    };
    const assetUrl = "https://github.com/o/x/releases/download/2.0.0/x-linux";
    const release = { assets: [{ name: "x-linux", digest: null }] };
    const { fetchFn } = fakeFetch({
      "https://api.github.com/repos/o/x/releases/tags/2.0.0": release,
      [assetUrl]: "bytes",
    });
    expect(await resolvePins(pinned, fetchFn)).toEqual({ linux: hex("bytes") });
    const missing = fakeFetch({
      "https://api.github.com/repos/o/x/releases/tags/2.0.0": { assets: [] },
    });
    await expect(resolvePins(pinned, missing.fetchFn)).rejects.toThrow("has no asset x-linux");
  });

  test("reads go.dev's digest of each Go archive", async () => {
    const pinned: PinnedDownload = {
      version: "1.30.0",
      download: "https://go.dev/dl/go{version}.{target}",
      sha256: { "linux-arm64.tar.gz": hex("old") },
    };
    const { fetchFn } = fakeFetch({
      "https://go.dev/dl/?mode=json&include=all": [
        { files: [{ filename: "go1.30.0.linux-arm64.tar.gz", sha256: hex("go") }] },
      ],
    });
    expect(await resolvePins(pinned, fetchFn)).toEqual({ "linux-arm64.tar.gz": hex("go") });
  });

  test("finds an Eclipse release's archive from latest.txt and reads its .sha256", async () => {
    const pinned: PinnedDownload = {
      version: "1.64.0",
      download: "https://download.eclipse.org/jdtls/milestones/{version}/{target}",
      sha256: { "jdt-language-server-1.63.0-1.tar.gz": hex("old") },
    };
    const base = "https://download.eclipse.org/jdtls/milestones/1.64.0";
    const { fetchFn } = fakeFetch({
      [`${base}/latest.txt`]: "jdt-language-server-1.64.0-2.tar.gz\n",
      [`${base}/jdt-language-server-1.64.0-2.tar.gz.sha256`]: `${hex("jdtls")}\n`,
    });
    expect(await resolvePins(pinned, fetchFn)).toEqual({
      "jdt-language-server-1.64.0-2.tar.gz": hex("jdtls"),
    });
  });

  test("downloads and hashes any other file", async () => {
    const pinned: PinnedDownload = {
      version: "3.0.0",
      download: "https://codeload.github.com/o/x/tar.gz/refs/tags/release/{version}",
      sha256: { source: hex("old") },
    };
    const { fetchFn } = fakeFetch({
      "https://codeload.github.com/o/x/tar.gz/refs/tags/release/3.0.0": "tarball",
    });
    expect(await resolvePins(pinned, fetchFn)).toEqual({ source: hex("tarball") });
  });
});

test("withPins replaces only the sha256 object, keeping the file's layout", () => {
  const before = `{\n  "version": "1.0.0",\n  "resources": ["x"],\n  "sha256": {\n    "a": "${hex("1")}"\n  }\n}\n`;
  expect(withPins(before, { a: hex("2"), b: hex("3") })).toBe(
    `{\n  "version": "1.0.0",\n  "resources": ["x"],\n  "sha256": {\n    "a": "${hex("2")}",\n    "b": "${hex("3")}"\n  }\n}\n`,
  );
});
