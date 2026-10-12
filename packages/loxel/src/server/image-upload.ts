/**
 * Pure helpers for the markdown image upload route (`POST /api/file-upload`).
 * Content sniffing, filename generation and markdown image-reference parsing.
 */
import { basename, extname } from "node:path";

import { IMAGE_EXTENSIONS, SVG_EXTENSION } from "@/lib/media-extensions";

/** Maximum accepted upload size (10 MB). */
export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Directory (relative to the markdown file) where uploaded images are stored in a project. */
export const IMAGE_ASSETS_DIR = "assets";

/** Formats `detectImageExtension` can recognise from content; the stored file extension. */
export type ImageExtension = "png" | "jpg" | "gif" | "webp" | "avif" | "bmp" | "svg";

/** Whether a file extension (without the dot, any case) is one the media viewer treats as an image. */
export function isImageExtension(ext: string): boolean {
  const lower = ext.toLowerCase();
  return IMAGE_EXTENSIONS.has(lower) || lower === SVG_EXTENSION;
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Detect the image type from file content (magic bytes), ignoring the client-declared MIME
 * type. Returns `null` for anything that is not a supported raster/vector image.
 */
export function detectImageExtension(bytes: Uint8Array): ImageExtension | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpg";
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) return "gif";
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "webp";
  if (asciiAt(bytes, 4, "ftypavif") || asciiAt(bytes, 4, "ftypavis")) return "avif";
  if (asciiAt(bytes, 0, "BM")) return "bmp";
  if (looksLikeSvg(bytes)) return "svg";
  return null;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, 1024))
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (!head.startsWith("<")) return false;
  // Skip XML declaration, comments and doctype to find the root element.
  const withoutPrologue = head.replace(
    /^(?:<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|\s)*/i,
    "",
  );
  return /^<svg[\s>/]/i.test(withoutPrologue);
}

const MAX_SLUG_LENGTH = 40;

/** Turn an arbitrary client-provided filename into a safe `[a-z0-9-]` slug. */
export function slugifyImageName(originalName: string): string {
  const stem = basename(originalName, extname(originalName));
  const slug = stem
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
  return slug || "image";
}

/** Compact local timestamp: `20260922-192130`. */
export function formatUploadTimestamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/** Build the stored filename: `<slug>-<timestamp>.<ext>` (`-2`, `-3`, ... when `attempt` > 1). */
export function buildImageFileName(
  originalName: string,
  ext: ImageExtension,
  now: Date = new Date(),
  attempt = 1,
): string {
  const suffix = attempt > 1 ? `-${attempt}` : "";
  return `${slugifyImageName(originalName)}-${formatUploadTimestamp(now)}${suffix}.${ext}`;
}

const MAX_NAME_ATTEMPTS = 20;

/**
 * Pick a filename that does not exist yet by attempting exclusive writes. `write` must throw
 * `EEXIST` when the name is taken (open with `wx`). Returns the name that was written.
 */
export async function writeWithUniqueName(
  originalName: string,
  ext: ImageExtension,
  write: (name: string) => Promise<void>,
): Promise<string> {
  const now = new Date();
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const name = buildImageFileName(originalName, ext, now, attempt);
    try {
      await write(name);
      return name;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`Could not find a free filename for ${originalName}`);
}

/**
 * Extract relative image references (`![alt](./x.png)` / `![alt](x.png "title")`) from
 * markdown, returning the referenced paths relative to the markdown file. Absolute, protocol
 * and data URLs are ignored. Percent-encoding is decoded.
 */
export function extractRelativeImageRefs(markdown: string): string[] {
  const refs = new Set<string>();
  // Destination is either `<...>` (may contain spaces) or a bare path (no whitespace or
  // unescaped parens; `\(` / `\)` escapes allowed), optionally followed by a title.
  const pattern =
    /!\[[^\]]*\]\(\s*(?:<([^<>\n]*)>|((?:[^\s()<>"\\]|\\.)+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  for (const match of markdown.matchAll(pattern)) {
    const raw = (match[1] ?? match[2] ?? "").replace(/\\(.)/g, "$1");
    if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(raw)) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
    refs.add(decoded.replace(/^\.\//, ""));
  }
  return [...refs];
}
