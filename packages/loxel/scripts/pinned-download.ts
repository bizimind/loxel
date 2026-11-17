/**
 * A download pinned by SHA256, as a language-server manifest (language-servers/*.json) and the Go
 * toolchain (go-toolchain.json) hold one:
 *
 *   { "version": "0.17.5", "download": "https://…/{version}/ruff-{target}",
 *     "sha256": { "aarch64-apple-darwin.tar.gz": "<hex>", … } }
 *
 * `download` is a URL template: `{version}` stands for `version` and `{target}` for a key of
 * `sha256`, which is the part of the file name the script picks for its platform (or a single name
 * when the URL has no `{target}`). Renovate (renovate.json) bumps `version`, and pin-hashes.ts
 * rewrites `sha256` for it, so no step by hand sets a digest.
 *
 * Imports nothing outside the runtime, so pin-hashes.ts runs in a checkout with no `pnpm install`.
 */

export interface PinnedDownload {
  version: string;
  download: string;
  sha256: Record<string, string>;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The pinned download in `json`, read from `file`. Throws when it is missing or malformed. */
export function readPinnedDownload(file: string, json: unknown): PinnedDownload {
  if (!isRecord(json)) throw new Error(`${file}: not a JSON object`);
  const { version, download, sha256 } = json;
  if (typeof version !== "string" || version === "") throw new Error(`${file}: needs "version"`);
  if (typeof download !== "string" || !download.startsWith("https://")) {
    throw new Error(`${file}: needs "download", an https URL template`);
  }
  if (!isRecord(sha256)) throw new Error(`${file}: needs "sha256", digests by target`);
  const pins: Record<string, string> = {};
  for (const [target, digest] of Object.entries(sha256)) {
    if (typeof digest !== "string" || !SHA256_HEX.test(digest)) {
      throw new Error(`${file}: "sha256" of ${target} is not a lowercase hex SHA256`);
    }
    pins[target] = digest;
  }
  return { version, download, sha256: pins };
}

/** The URL of `target`'s file for the pinned version. */
export function downloadUrl(pinned: PinnedDownload, target: string): string {
  return pinned.download.replaceAll("{version}", pinned.version).replaceAll("{target}", target);
}

/** The URL and pinned SHA256 of `target`'s file. Throws, naming the fix, when none is pinned. */
export function pinnedFile(
  name: string,
  pinned: PinnedDownload,
  target: string,
): { url: string; sha256: string } {
  const sha256 = pinned.sha256[target];
  if (!sha256) {
    throw new Error(
      `${name} pins no SHA256 for ${target} at ${pinned.version}; ` +
        `run \`pnpm -C packages/loxel run pin-hashes ${name}\``,
    );
  }
  return { url: downloadUrl(pinned, target), sha256 };
}
