/**
 * Shared download step for language servers released as one binary in a
 * tarball (or a zip on Windows), such as ruff and Tombi. The archive is
 * verified against its pinned SHA256 in memory before anything is extracted,
 * and only the binary is extracted from it.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const BUILD_DIR = path.resolve(import.meta.dir, "..", "build");

/** The Rust target triple of this machine, with Linux builds for `linuxLibc`. */
export function rustTarget(linuxLibc: "gnu" | "musl"): string {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : "";
  const os =
    process.platform === "darwin"
      ? "apple-darwin"
      : process.platform === "linux"
        ? `unknown-linux-${linuxLibc}`
        : process.platform === "win32"
          ? "pc-windows-msvc"
          : "";
  return `${arch}-${os}`;
}

/**
 * Whether `out` is installed from `source`, as recorded by {@link recordInstalledFrom}: a pinned
 * digest or build input, so a binary left by an older checkout is replaced. When it is not, `out`
 * and its record are removed, ready for a fresh install.
 */
export function installedFrom(out: string, source: string): boolean {
  const record = `${out}.source`;
  if (existsSync(out) && existsSync(record) && readFileSync(record, "utf8") === source) return true;
  rmSync(record, { force: true });
  rmSync(out, { recursive: true, force: true });
  return false;
}

/** Records that `out` is installed from `source`; written last, so it marks a finished install. */
export function recordInstalledFrom(out: string, source: string): void {
  writeFileSync(`${out}.source`, source);
}

export interface ReleaseBinary {
  /** Tool name, for messages and the scratch directory. */
  name: string;
  url: string;
  sha256: string;
  /** Path of the binary inside the archive, or of a directory holding a whole toolchain. */
  member: string;
  /** Where it is installed. */
  outBinary: string;
}

/** Download, verify and extract `member`, unless `outBinary` is from this archive. Throws on failure. */
export async function downloadReleaseBinary({
  name,
  url,
  sha256,
  member,
  outBinary,
}: ReleaseBinary): Promise<void> {
  if (installedFrom(outBinary, sha256)) {
    console.log(`${name} already present at ${outBinary}, skipping download`);
    return;
  }

  const outDir = path.dirname(outBinary);
  mkdirSync(outDir, { recursive: true });

  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);

  const bytes = new Uint8Array(await res.arrayBuffer());
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== sha256) {
    throw new Error(`SHA256 mismatch!\n  expected: ${sha256}\n  actual:   ${actualHash}`);
  }

  // Extract in a scratch directory of its own, so nothing but the binary reaches `outDir`.
  const scratch = mkdtempSync(path.join(outDir, `${name}-download-`));
  try {
    const archivePath = path.join(scratch, path.basename(new URL(url).pathname));
    await Bun.write(archivePath, bytes);
    console.log("Extracting (SHA256 verified)...");
    // bsdtar (macOS, Windows) reads zips too; GNU tar on Linux only gets tarballs.
    const tar = Bun.spawn(["tar", "-xf", archivePath, "-C", scratch, member], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await tar.exited) !== 0) throw new Error("tar failed");
    const extracted = path.join(scratch, member);
    if (!existsSync(extracted)) {
      throw new Error(`Expected ${extracted} after extraction but it was not found`);
    }
    renameSync(extracted, outBinary);
    chmodSync(outBinary, 0o755);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  recordInstalledFrom(outBinary, sha256);
  console.log(`Installed: ${outBinary}`);
}
