export const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "ico",
  "avif",
]);

export const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "avi", "mkv", "ogv"]);

export const SVG_EXTENSION = "svg";

export const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, SVG_EXTENSION]);

export type MediaType = "image" | "video" | "svg";

export function getMediaType(filePath: string): MediaType | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (ext === SVG_EXTENSION) return "svg";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return null;
}

export function isMediaFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return MEDIA_EXTENSIONS.has(ext);
}
