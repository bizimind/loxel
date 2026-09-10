import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import type { UpdateState } from "@/api/update-model";
import type { WsMessage } from "@/api/ws-protocol";

import { config } from "./config";
import { logger } from "./logger";
import { getCurrentVersion } from "./version";

const log = logger.child("update");

const MANIFEST_URL = "https://loxel.bizimind.io/loxel/manifest.json";
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Server-internal state extends UpdateState with download details for the "available"/"ready" states. */
type InternalUpdateState =
  | Exclude<UpdateState, { state: "available" | "ready" }>
  | { state: "available"; version: string; releasedAt: string; url: string; sha256: string }
  | { state: "ready"; version: string; archivePath: string; sha256: string };

// --- Manifest schema ---

const BinaryInfoSchema = z.object({ url: z.string(), sha256: z.string() });
const ManifestSchema = z.object({
  version: z.string(),
  released_at: z.string(),
  binaries: z.record(z.string(), BinaryInfoSchema),
});

// --- Module state ---

let currentState: InternalUpdateState = { state: "idle" };

/** Return the client-facing update state (omits internal fields). */
export function getUpdateStatus(): UpdateState {
  if (currentState.state === "available") {
    return {
      state: "available",
      version: currentState.version,
      releasedAt: currentState.releasedAt,
    };
  }
  if (currentState.state === "ready") {
    return { state: "ready", version: currentState.version };
  }
  return currentState;
}

function setState(next: InternalUpdateState, broadcastAlways: (msg: WsMessage) => void): void {
  currentState = next;
  broadcastAlways({ type: "update_status_changed", data: getUpdateStatus() });
}

// --- Platform ---

function getCurrentPlatform(): string {
  const os = platform();
  if (os !== "darwin" && os !== "linux") {
    throw new Error(`Unsupported platform: ${os}`);
  }
  const cpu = arch() === "arm64" ? "arm64" : "x64";
  return `${os}-${cpu}`;
}

// --- Version comparison ---

function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA !== numB) return numA - numB;
  }
  return 0;
}

// --- Check for update ---

export async function checkForUpdate(broadcastAlways: (msg: WsMessage) => void): Promise<void> {
  if (currentState.state === "checking" || currentState.state === "downloading") return;

  // Remember if we have a downloaded version so we can fall back to it
  const previousReady = currentState.state === "ready" ? currentState : null;

  setState({ state: "checking" }, broadcastAlways);

  try {
    const response = await fetch(MANIFEST_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch manifest: ${response.status} ${response.statusText}`);
    }

    const data: unknown = await response.json();
    const parsed = ManifestSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`Invalid manifest format: ${parsed.error.message}`);
    }

    const manifest = parsed.data;
    const current = getCurrentVersion();

    if (compareVersions(manifest.version, current) <= 0) {
      // Manifest version is not newer than the running version — fully up to date
      setState({ state: "idle" }, broadcastAlways);
      log.info(`Up to date (${current})`);
      return;
    }

    // Manifest has a version newer than the running one. If we already downloaded
    // that exact version, stay in "ready" instead of asking the user to re-download.
    if (previousReady && manifest.version === previousReady.version) {
      setState(previousReady, broadcastAlways);
      log.info(`Already downloaded ${manifest.version}, staying in ready state`);
      return;
    }

    const platformKey = getCurrentPlatform();
    const binaryInfo = manifest.binaries[platformKey];
    if (!binaryInfo) {
      throw new Error(`No update available for platform: ${platformKey}`);
    }

    setState(
      {
        state: "available",
        version: manifest.version,
        releasedAt: manifest.released_at,
        url: binaryInfo.url,
        sha256: binaryInfo.sha256,
      },
      broadcastAlways,
    );
    log.info(`Update available: ${current} → ${manifest.version}`);
  } catch (err) {
    // On error, restore the previous ready state if we had one
    if (previousReady) {
      setState(previousReady, broadcastAlways);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      setState({ state: "error", message }, broadcastAlways);
    }
    log.error("Update check failed", { error: err });
  }
}

// --- Download update ---

export async function downloadUpdate(broadcastAlways: (msg: WsMessage) => void): Promise<void> {
  if (currentState.state !== "available") return;
  const { version, url, sha256 } = currentState;

  setState({ state: "downloading", version }, broadcastAlways);

  try {
    const platformKey = getCurrentPlatform();

    // Download the archive with timeout
    const archiveResponse = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!archiveResponse.ok) {
      throw new Error(`Failed to download archive: ${archiveResponse.status}`);
    }

    const buffer = await archiveResponse.arrayBuffer();
    const data = new Uint8Array(buffer);

    // Verify SHA256
    const hash = createHash("sha256").update(data).digest("hex");
    if (hash !== sha256) {
      throw new Error(`SHA256 mismatch: expected ${sha256}, got ${hash}`);
    }

    // Write to updates directory
    mkdirSync(config.updatesDir, { recursive: true });
    const archivePath = join(config.updatesDir, `loxel-update-${version}-${platformKey}.tar.gz`);
    await Bun.write(archivePath, data);

    setState({ state: "ready", version, archivePath, sha256 }, broadcastAlways);
    log.info(`Update downloaded and verified: ${archivePath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setState({ state: "error", message }, broadcastAlways);
    log.error("Update download failed", { error: err });
  }
}

// --- Prepare install ---

export function prepareInstall(): boolean {
  if (currentState.state !== "ready") return false;

  const resourcesDir = process.env.LOXEL_RESOURCES_DIR;
  if (!resourcesDir) return false;

  const pending = {
    version: currentState.version,
    archivePath: currentState.archivePath,
    targetDir: resourcesDir,
    sha256: currentState.sha256,
  };

  mkdirSync(config.updatesDir, { recursive: true });
  writeFileSync(join(config.updatesDir, "pending.json"), JSON.stringify(pending, null, 2));

  log.info(`Update prepared for install: v${pending.version}`);
  return true;
}

// --- Cleanup stale updates ---

export function cleanupStaleUpdates(): void {
  if (!existsSync(config.updatesDir)) return;

  try {
    // Remove pending.json if it exists (leftover from interrupted update)
    const pendingPath = join(config.updatesDir, "pending.json");
    if (existsSync(pendingPath)) {
      unlinkSync(pendingPath);
      log.info("Cleaned up stale pending.json");
    }

    // Remove any leftover .tar.gz files
    const entries = readdirSync(config.updatesDir);
    for (const entry of entries) {
      if (entry.endsWith(".tar.gz")) {
        unlinkSync(join(config.updatesDir, entry));
        log.info(`Cleaned up stale archive: ${entry}`);
      }
    }

    // Remove backup directory if it exists (means previous update succeeded)
    const backupDir = join(config.updatesDir, "backup");
    if (existsSync(backupDir)) {
      rmSync(backupDir, { recursive: true });
      log.info("Cleaned up update backup (previous update succeeded)");
    }
  } catch (err) {
    log.warn("Failed to clean up stale updates", { error: err });
  }
}
