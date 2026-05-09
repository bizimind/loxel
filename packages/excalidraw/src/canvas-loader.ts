import { createHash } from "node:crypto";
/**
 * Canvas loader that works in both dev mode (bun run) and compiled binary mode.
 *
 * In dev mode: loads @napi-rs/canvas from node_modules normally.
 * In compiled mode: extracts the embedded native binary to a cache directory,
 * then loads it via process.dlopen.
 *
 * Font files are also embedded and extracted to cache for compiled binaries.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// @ts-expect-error -- Bun file import
import cascadiaFile from "../fonts/CascadiaCode-Regular.ttf" with { type: "file" };
// @ts-expect-error -- Bun file import
import liberationFile from "../fonts/LiberationSans-Regular.ttf" with { type: "file" };
// @ts-expect-error -- Bun file import
import virgilFile from "../fonts/Virgil-Regular.ttf" with { type: "file" };
// Embed native binary and fonts — Bun inlines these into the compiled binary.
// In dev mode they resolve to regular filesystem paths.
// @ts-expect-error -- Bun file import
import nativeBindingFile from "../native/skia.darwin-arm64.bin" with { type: "file" };

const isCompiled = (nativeBindingFile as string).startsWith("/$bunfs/");

const CACHE_DIR = path.join(os.homedir(), ".cache", "excalidraw-cli");

/**
 * Compute a short hash of the native binary to version the cache.
 * Ensures re-extraction when the binary is updated.
 */
function getCacheVersion(): string {
  const data = fs.readFileSync(nativeBindingFile);
  return createHash("sha256").update(data).digest("hex").slice(0, 12);
}

let _cacheDir: string | null = null;

function getVersionedCacheDir(): string {
  if (_cacheDir) return _cacheDir;
  const version = getCacheVersion();
  _cacheDir = path.join(CACHE_DIR, version);
  return _cacheDir;
}

/**
 * In compiled mode, extract embedded files to a versioned cache directory.
 * Skips extraction if the cache already exists.
 */
function ensureExtracted(): string {
  const dir = getVersionedCacheDir();

  const marker = path.join(dir, ".complete");
  if (fs.existsSync(marker)) return dir;

  fs.mkdirSync(dir, { recursive: true });

  const files: [string, string][] = [
    [nativeBindingFile, "skia.darwin-arm64.node"],
    [virgilFile, "Virgil-Regular.ttf"],
    [cascadiaFile, "CascadiaCode-Regular.ttf"],
    [liberationFile, "LiberationSans-Regular.ttf"],
  ];

  for (const [src, name] of files) {
    const dest = path.join(dir, name);
    if (!fs.existsSync(dest)) {
      fs.writeFileSync(dest, fs.readFileSync(src));
    }
  }

  // Mark extraction complete
  fs.writeFileSync(marker, "");
  return dir;
}

// --- Load native binding ---

// The native binding is loaded at runtime via require() or process.dlopen().
// Its shape mirrors @napi-rs/canvas exports but has no static type declarations.
// We type it loosely here since the module patches prototypes at load time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NativeBinding = Record<string, any>;

async function loadNativeBinding(): Promise<NativeBinding> {
  if (!isCompiled) {
    // Dev mode — use dynamic import for native binding resolution
    // @ts-expect-error — native binding has no type declarations
    return (await import("@napi-rs/canvas/js-binding")) as NativeBinding;
  }

  // Compiled mode — load from cache
  const cacheDir = ensureExtracted();
  const nodePath = path.join(cacheDir, "skia.darwin-arm64.node");
  const mod: { exports: NativeBinding } = { exports: {} };
  process.dlopen(mod, nodePath);
  return mod.exports;
}

const binding = await loadNativeBinding();

const { CanvasElement, SVGCanvas, GlobalFonts: _GlobalFonts } = binding;

// --- Apply patches from @napi-rs/canvas/index.js ---

// Patch getTransform to return a proper DOMMatrix-like object
const _getTransform = binding.CanvasRenderingContext2D.prototype.getTransform;
binding.CanvasRenderingContext2D.prototype.getTransform = function getTransform() {
  return _getTransform.apply(this, arguments);
};

// Patch drawImage for cross-canvas compatibility
const _drawImage = binding.CanvasRenderingContext2D.prototype.drawImage;
binding.CanvasRenderingContext2D.prototype.drawImage = function drawImage(
  image: unknown,
  ...args: unknown[]
) {
  let source: unknown = image;
  if (source !== null && typeof source === "object") {
    const s = source as Record<string, unknown>;
    if (s.canvas instanceof CanvasElement || s.canvas instanceof SVGCanvas) {
      source = s.canvas;
    } else if (s._canvas instanceof CanvasElement || s._canvas instanceof SVGCanvas) {
      source = s._canvas;
    } else if (typeof s.getContext === "function" && s.width && s.height) {
      if (!(source instanceof CanvasElement) && !(source instanceof SVGCanvas)) {
        Object.setPrototypeOf(source, CanvasElement.prototype);
      }
    }
  }
  return _drawImage.apply(this, [source, ...args]);
};

// Add families getter to GlobalFonts
if (!("families" in _GlobalFonts)) {
  Object.defineProperty(_GlobalFonts, "families", {
    get() {
      return JSON.parse(_GlobalFonts.getFamilies().toString());
    },
  });
}

// --- Don't load system fonts (we register our own) ---
// The original index.js loads system fonts, but we skip that for
// deterministic rendering and faster startup.

// --- Exports ---

export function createCanvas(width: number, height: number) {
  return new CanvasElement(width, height);
}

export const GlobalFonts = _GlobalFonts;
export const Image = binding.Image;

/**
 * Get the directory containing font files.
 * In dev mode: the local fonts/ directory.
 * In compiled mode: the cache directory with extracted fonts.
 */
export function getFontsDir(): string {
  if (isCompiled) {
    return ensureExtracted();
  }
  return path.join(import.meta.dirname, "..", "fonts");
}
