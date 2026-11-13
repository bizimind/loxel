/**
 * The host build ID: a hash of the terminal host's bundled code plus the Bun version, which names
 * a generation of hosts. A release that changes neither keeps the ID, so its server reuses the
 * hosts already running. scripts/build-server.ts computes it and embeds it in the host and the
 * server as `LOXEL_TERMINAL_HOST_BUILD_ID`; run from source, it is computed the same way at startup.
 * See docs/TERMINAL_HOST.md#generations.
 */
import { join } from "node:path";

declare const LOXEL_TERMINAL_HOST_BUILD_ID: string | undefined;

/** The host's entry point in the source tree. */
export const TERMINAL_HOST_ENTRY = join(import.meta.dir, "main.ts");

/** The ID embedded at build time, or null when running from source. */
export function embeddedHostBuildId(): string | null {
  return typeof LOXEL_TERMINAL_HOST_BUILD_ID === "string" ? LOXEL_TERMINAL_HOST_BUILD_ID : null;
}

/**
 * Hash the host's bundle, minified so that comments and formatting do not start a new generation,
 * with the Bun version that runs it.
 */
export async function computeHostBuildId(entry = TERMINAL_HOST_ENTRY): Promise<string> {
  const result = await Bun.build({ entrypoints: [entry], target: "bun", minify: true });
  if (!result.success) {
    throw new Error("Could not bundle the terminal host to compute its build ID", {
      cause: new AggregateError(result.logs),
    });
  }
  const hasher = new Bun.CryptoHasher("sha256");
  for (const output of result.outputs) hasher.update(await output.arrayBuffer());
  hasher.update(Bun.version);
  return hasher.digest("hex").slice(0, 16);
}

/** The current build's host build ID: the embedded one, or else computed from source. */
export async function currentHostBuildId(): Promise<string> {
  return embeddedHostBuildId() ?? (await computeHostBuildId());
}
