import type { ProviderType } from "./provider.ts";

interface DetectionEntry {
  type: ProviderType;
  bin: string;
  /** Only available on this platform (undefined = all platforms) */
  platform?: NodeJS.Platform;
}

/** Preference order: Apple Containers > Podman > Docker */
const DETECTION_ORDER: DetectionEntry[] = [
  { type: "apple", bin: "container", platform: "darwin" },
  { type: "podman", bin: "podman" },
  { type: "docker", bin: "docker" },
];

function binaryExists(bin: string): boolean {
  const result = Bun.spawnSync(["which", bin], { stdout: "ignore", stderr: "ignore" });
  return result.exitCode === 0;
}

/** Detect all available container runtimes, in preference order. */
export function detectProviders(): ProviderType[] {
  return DETECTION_ORDER.filter(
    (entry) =>
      (entry.platform === undefined || entry.platform === process.platform) &&
      binaryExists(entry.bin),
  ).map((entry) => entry.type);
}

/** Detect the preferred (first available) provider. Returns null if none found. */
export function detectPreferredProvider(): ProviderType | null {
  return detectProviders()[0] ?? null;
}
