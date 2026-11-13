import type { OutgoingHttpHeaders } from "node:http";

import { Provider, type UpdateFileInfo, type UpdateInfo } from "electron-updater";
import type { ResolvedUpdateFileInfo } from "electron-updater";
// Not exported from the package root, and the root's custom-provider option types it as `any`.
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";
import { z } from "zod";

/**
 * The release manifest the release workflow publishes. The site's download page reads its `app`
 * entries; the app updater reads `update`.
 */
export const MANIFEST_URL = "https://loxel.bizimind.io/loxel/manifest.json";

const UpdateFileSchema = z.object({
  url: z.url(),
  /** Base64 SHA-512 of the zip, which electron-updater checks after downloading it. */
  sha512: z.string().min(1),
  size: z.number().int().positive(),
});

const ManifestSchema = z.object({
  version: z.string(),
  released_at: z.string(),
  /** The app zip per `<platform>-<arch>` key, e.g. `darwin-arm64`. */
  update: z.record(z.string(), UpdateFileSchema),
  /**
   * The terminal host protocol the release speaks (`TERMINAL_HOST_PROTOCOL`). Releases from before
   * terminal host versioning leave it out.
   */
  terminal_host_protocol: z.string().optional(),
});

/**
 * What Loxel's manifest adds to electron-updater's update info. electron-updater hands the object
 * the provider returns to its `update-available` event as is, so the field arrives there.
 */
export interface LoxelUpdateInfo extends UpdateInfo {
  terminalHostProtocol?: string;
}

const LoxelUpdateInfoSchema = z.object({ terminalHostProtocol: z.string().optional() });

/** The terminal host protocol of an update, as {@link updateInfoFromManifest} read it. */
export function terminalHostProtocolOf(info: UpdateInfo): string | undefined {
  const parsed = LoxelUpdateInfoSchema.safeParse(info);
  return parsed.success ? parsed.data.terminalHostProtocol : undefined;
}

/**
 * The update info for `platform` in a parsed manifest. It lists that platform's zip for every
 * architecture: electron-updater's macOS updater picks the one for this Mac by whether its URL
 * names `arm64`, and moves an Intel build running under Rosetta to the Apple silicon one.
 */
export function updateInfoFromManifest(data: unknown, platform: string): LoxelUpdateInfo {
  const manifest = ManifestSchema.parse(data);
  const files: UpdateFileInfo[] = Object.entries(manifest.update)
    .filter(([key]) => key.startsWith(`${platform}-`))
    .map(([, file]) => ({ url: file.url, sha512: file.sha512, size: file.size }));
  const [first] = files;
  if (!first) throw new Error(`Release ${manifest.version} has no ${platform} update`);
  return {
    version: manifest.version,
    releaseDate: manifest.released_at,
    files,
    // Deprecated single-file fields electron-updater still requires.
    path: first.url,
    sha512: first.sha512,
    ...(manifest.terminal_host_protocol === undefined
      ? {}
      : { terminalHostProtocol: manifest.terminal_host_protocol }),
  };
}

/** Header electron-updater adds to update checks: a random ID it stores per installation. */
const STAGING_ID_HEADER = "x-user-staging-id";

/**
 * Reads updates from the release manifest, so the manifest stays the one description of a
 * release. Registered with `setFeedURL({ provider: "custom", updateProvider: ManifestProvider })`.
 */
export class ManifestProvider extends Provider<UpdateInfo> {
  private readonly platform: string;

  constructor(_options: unknown, _updater: unknown, runtimeOptions: ProviderRuntimeOptions) {
    super(runtimeOptions);
    this.platform = runtimeOptions.platform;
  }

  /**
   * Drops the staging ID: it would let the update server tell installations apart, and Loxel's
   * update check identifies nothing (staged rollouts, its only use, are unused).
   */
  override setRequestHeaders(value: OutgoingHttpHeaders | null) {
    if (value === null) {
      super.setRequestHeaders(null);
      return;
    }
    const { [STAGING_ID_HEADER]: _stagingId, ...rest } = value;
    super.setRequestHeaders(rest);
  }

  /**
   * One range per request when downloading only the changed blocks: the origin rejects multi-range
   * requests, and Cloudflare answers them only for zips it has already cached.
   */
  override get isUseMultipleRangeRequest(): boolean {
    return false;
  }

  async getLatestVersion(): Promise<UpdateInfo> {
    // no-cache: electron-updater's session keeps no HTTP cache, but a proxy on the way might, and
    // the manifest is served with a Last-Modified date and no caching headers.
    const body = await this.httpRequest(new URL(MANIFEST_URL), { "cache-control": "no-cache" });
    if (body === null) throw new Error(`Empty response from ${MANIFEST_URL}`);
    const data: unknown = JSON.parse(body);
    return updateInfoFromManifest(data, this.platform);
  }

  resolveFiles(updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] {
    return updateInfo.files.map((info) => ({ url: new URL(info.url), info }));
  }
}
