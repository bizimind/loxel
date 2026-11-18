import { createHash, randomBytes } from "node:crypto";
import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { verifyCodeSignature } from "./code-signature.ts";
import type { BinaryInfo, Manifest } from "./manifest.ts";
import { getBinaryInfo } from "./manifest.ts";
import { getCurrentPlatform } from "./platform.ts";

/**
 * Check if running as a compiled binary (vs via bun/node interpreter).
 */
export function isRunningCompiled(): boolean {
  const execName = path.basename(process.execPath);
  // When running compiled, execPath points to the binary itself (e.g., "wt")
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
  /** The package name (used for safety check, e.g., "wt", "code-analysis") */
  packageName: string;
  /** Custom message for development mode error */
  devModeMessage?: string;
}

/**
 * Perform an atomic binary update. The binary must match the SHA-256 in the (signed) manifest and,
 * on macOS, carry the release code signature; otherwise the running binary is left as it was.
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
  const buffer = await downloadAndVerify(binaryInfo);

  // Unique and created exclusively, so concurrent updates (several agents running the CLI as its
  // update check comes due) never verify or install one another's half-written file.
  const tempPath = `${currentBinaryPath}.update-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tempPath, buffer, { flag: "wx" });
    await chmod(tempPath, 0o755);
    if (process.platform === "darwin") await verifyCodeSignature(tempPath, options.packageName);
    // Atomic replace
    await rename(tempPath, currentBinaryPath);
  } catch (err) {
    // Never leave a rejected or half-written binary next to the real one.
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
}
