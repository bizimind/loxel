import { describe, expect, mock, test } from "bun:test";
import type { OutgoingHttpHeaders, RequestOptions } from "node:http";

import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";

// electron-updater requires `electron`, whose npm package would download Electron itself.
void mock.module("electron", () => ({}));
const { MANIFEST_URL, ManifestProvider, terminalHostProtocolOf, updateInfoFromManifest } =
  await import("./update-manifest");

const BASE = "https://loxel.bizimind.io/loxel/app";

const manifest = {
  version: "0.1.400",
  released_at: "2026-11-06T10:00:00Z",
  app: {
    "darwin-arm64": { url: `${BASE}/darwin-arm64/Loxel-0.1.400-mac-arm64.dmg`, sha256: "aa" },
  },
  update: {
    "darwin-arm64": {
      url: `${BASE}/darwin-arm64/Loxel-0.1.400-mac-arm64.zip`,
      sha512: "arm64-sha512",
      size: 1000,
    },
    "darwin-x64": {
      url: `${BASE}/darwin-x64/Loxel-0.1.400-mac-x64.zip`,
      sha512: "x64-sha512",
      size: 2000,
    },
  },
};

describe("updateInfoFromManifest", () => {
  test("lists the platform's zip for every architecture", () => {
    const info = updateInfoFromManifest(manifest, "darwin");
    expect(info.version).toBe("0.1.400");
    expect(info.releaseDate).toBe("2026-11-06T10:00:00Z");
    expect(info.files).toEqual([
      { url: manifest.update["darwin-arm64"].url, sha512: "arm64-sha512", size: 1000 },
      { url: manifest.update["darwin-x64"].url, sha512: "x64-sha512", size: 2000 },
    ]);
  });

  test("fails for a platform the release has no update for", () => {
    expect(() => updateInfoFromManifest(manifest, "linux")).toThrow("has no linux update");
  });

  test("carries the release's terminal host protocol, which older manifests leave out", () => {
    const info = updateInfoFromManifest({ ...manifest, terminal_host_protocol: "1.1.0" }, "darwin");
    expect(terminalHostProtocolOf(info)).toBe("1.1.0");
    expect(terminalHostProtocolOf(updateInfoFromManifest(manifest, "darwin"))).toBeUndefined();
  });

  test("rejects a manifest without update entries", () => {
    const { update: _update, ...withoutUpdates } = manifest;
    expect(() => updateInfoFromManifest(withoutUpdates, "darwin")).toThrow();
  });
});

describe("ManifestProvider", () => {
  /** A provider whose HTTP requests are recorded and answered with the manifest. */
  function providerWithRequests() {
    const requests: RequestOptions[] = [];
    const executor = {
      request: async (options: RequestOptions) => {
        requests.push(options);
        return JSON.stringify(manifest);
      },
    };
    const runtimeOptions = {
      isUseMultipleRangeRequest: true,
      platform: "darwin",
      executor,
    } as unknown as ProviderRuntimeOptions;
    return { provider: new ManifestProvider({}, {}, runtimeOptions), requests };
  }

  test("reads the release manifest, revalidating any cached copy", async () => {
    const { provider, requests } = providerWithRequests();
    const info = await provider.getLatestVersion();
    expect(info.version).toBe("0.1.400");
    expect(requests).toHaveLength(1);
    expect(`https://${requests[0]?.hostname}${requests[0]?.path}`).toBe(MANIFEST_URL);
    expect(requests[0]?.headers).toMatchObject({ "cache-control": "no-cache" });
  });

  test("sends no installation ID with the update check", async () => {
    const { provider, requests } = providerWithRequests();
    const headers: OutgoingHttpHeaders = { "x-user-staging-id": "per-install-id", accept: "*/*" };
    provider.setRequestHeaders(headers);
    await provider.getLatestVersion();
    expect(requests[0]?.headers).not.toHaveProperty("x-user-staging-id");
    expect(requests[0]?.headers).toMatchObject({ accept: "*/*" });
  });

  test("resolves each zip to its URL", () => {
    const { provider } = providerWithRequests();
    const info = updateInfoFromManifest(manifest, "darwin");
    expect(provider.resolveFiles(info).map((file) => file.url.href)).toEqual([
      manifest.update["darwin-arm64"].url,
      manifest.update["darwin-x64"].url,
    ]);
  });
});
