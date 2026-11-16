/**
 * canvas-loader.ts embeds the @napi-rs/canvas native (skia) binary with a
 * `{ type: "file" }` import of native/skia.darwin-arm64.bin, so the file must
 * exist to bundle, compile, test or run the CLI from source. It is gitignored
 * (platform-specific), so this copies the current platform's binary from
 * node_modules. The filename is always skia.darwin-arm64.bin (it matches the
 * import); outside compiled binaries only its existence matters.
 */
import fs from "node:fs";
import { resolve } from "node:path";

const root = import.meta.dirname;
const nativeDir = resolve(root, "native");
export const nativeBinaryPath = resolve(nativeDir, "skia.darwin-arm64.bin");

/** Copy the native binary into place if it's missing. Returns whether it copied it. */
export async function ensureNativeBinary(): Promise<boolean> {
  if (fs.existsSync(nativeBinaryPath)) return false;
  const { stdout } =
    await Bun.$`find ${resolve(root, "../../node_modules")} -maxdepth 6 -name 'skia.*.node' -path '*napi*canvas*' -print -quit`.quiet();
  const srcPath = stdout.toString().trim();
  if (!srcPath) throw new Error("Could not find @napi-rs/canvas native binary in node_modules");
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.copyFileSync(srcPath, nativeBinaryPath);
  return true;
}

/** Remove a native binary that ensureNativeBinary copied, and its directory if empty. */
export function removeNativeBinary(): void {
  fs.unlinkSync(nativeBinaryPath);
  try {
    fs.rmdirSync(nativeDir);
  } catch {
    // Not empty — leave it
  }
}

if (import.meta.main) await ensureNativeBinary();
