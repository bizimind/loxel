/**
 * Bundle the excalidraw CLI into dist/cli.js.
 *
 * Native addons (@napi-rs/canvas) are marked external — they must be
 * available at runtime via node_modules.
 *
 * canvas-loader.ts embeds the native skia binary via { type: "file" } import
 * for bun --compile. The binary is gitignored (platform-specific), so the
 * build script copies it from node_modules before bundling.
 */
import fs from "node:fs";
import { resolve } from "node:path";

const root = import.meta.dirname;
const nativeDir = resolve(root, "native");
const nativeBin = resolve(nativeDir, "skia.darwin-arm64.bin");

// Copy the platform's native binary from node_modules if not already present.
// The filename is always skia.darwin-arm64.bin (matches canvas-loader.ts import).
// For bundling, only the file's existence matters — content is platform-specific.
let copiedBinary = false;
if (!fs.existsSync(nativeBin)) {
  const { stdout } =
    await Bun.$`find ${resolve(root, "../../node_modules")} -maxdepth 6 -name 'skia.*.node' -path '*napi*canvas*' -print -quit`.quiet();
  const srcPath = stdout.toString().trim();
  if (!srcPath) throw new Error("Could not find @napi-rs/canvas native binary in node_modules");
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.copyFileSync(srcPath, nativeBin);
  copiedBinary = true;
}

const outBinary = resolve(root, "dist/excalidraw");

try {
  await Bun.$`mkdir -p ${resolve(root, "dist")}`;
  await Bun.$`bun build ${resolve(root, "src/cli.ts")} --compile --minify --outfile ${outBinary}`.quiet();
} finally {
  if (copiedBinary) {
    fs.unlinkSync(nativeBin);
    try {
      fs.rmdirSync(nativeDir);
    } catch {
      // Not empty — leave it
    }
  }
}

console.log(`Built ${outBinary}`);
