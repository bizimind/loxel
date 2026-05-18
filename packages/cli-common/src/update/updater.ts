import { createHash } from "node:crypto";
import { chmod, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type { BinaryInfo, Manifest } from "./manifest.ts";
import { getBinaryInfo } from "./manifest.ts";
import { getCurrentPlatform } from "./platform.ts";

/**
 * Check if running as a compiled binary (vs via bun/node interpreter).
 */
export function isRunningCompiled(): boolean {
  const execName = path.basename(process.execPath);
  // When running compiled, execPath points to the binary itself (e.g., "ccm")
  // When running via interpreter, it points to "bun" or "node" (with optional version suffix)
  return !/^(bun|node)(\d.*)?$/.test(execName);
}

/**
 * Download a binary and verify its SHA256 checksum.
 */
export async function downloadAndVerify(binaryInfo: BinaryInfo): Promise<Buffer> {
  const response = await fetch(binaryInfo.url);

  if (!response.ok) {
    throw new Error(`Failed to download binary: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  const hash = createHash("sha256").update(buffer).digest("hex");
  if (hash !== binaryInfo.sha256) {
    throw new Error(`Checksum verification failed.\nExpected: ${binaryInfo.sha256}\nGot: ${hash}`);
  }

  return buffer;
}

export interface PerformUpdateOptions {
  /** The package name (used for safety check, e.g., "ccm", "wt", "remote-claude") */
  packageName: string;
  /** Custom message for development mode error */
  devModeMessage?: string;
}

/**
 * Perform an atomic binary update.
 */
export async function performUpdate(
  manifest: Manifest,
  options: PerformUpdateOptions,
): Promise<void> {
  if (!isRunningCompiled()) {
    const defaultMsg =
      `Cannot run update in development mode. Install ${options.packageName} as a standalone binary first.\n` +
      `Run: bun run build && cp dist/${options.packageName} ~/.local/bin/ && codesign -s - ~/.local/bin/${options.packageName}`;
    throw new Error(options.devModeMessage ?? defaultMsg);
  }

  const platform = getCurrentPlatform();
  const binaryInfo = getBinaryInfo(manifest, platform);

  const currentBinaryPath = process.execPath;
  const execName = path.basename(currentBinaryPath);
  if (!execName.includes(options.packageName)) {
    throw new Error(
      `Refusing to update: binary path "${currentBinaryPath}" does not appear to be ${options.packageName}`,
    );
  }
  const tempPath = `${currentBinaryPath}.update`;

  const buffer = await downloadAndVerify(binaryInfo);

  await Bun.write(tempPath, buffer);
  await chmod(tempPath, 0o755);

  // Atomic replace
  await rename(tempPath, currentBinaryPath);
}

/**
 * Clean up a failed update by removing the temp file.
 */
export async function cleanupFailedUpdate(): Promise<void> {
  const tempPath = `${process.execPath}.update`;
  try {
    await unlink(tempPath);
  } catch {
    // Ignore if file doesn't exist
  }
}
