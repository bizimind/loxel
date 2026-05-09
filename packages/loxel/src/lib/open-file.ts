import { dispatchLoxelEvent } from "./loxel-events";
import { isMediaFile } from "./media-extensions";

export interface FileLocation {
  line: number;
  column: number;
}

/**
 * Parse a go-to-line suffix from a file search query.
 * Supports `query:line` and `query:line:col` formats.
 * Returns the search portion and optional file location.
 */
export function parseQueryLocation(raw: string): { search: string; location?: FileLocation } {
  const match = raw.match(/^(.+?):(\d+)(?::(\d+))?$/);
  if (!match) return { search: raw };
  const line = Number(match[2]);
  if (line === 0) return { search: raw };
  const column = match[3] ? Number(match[3]) : undefined;
  return { search: match[1]!, location: { line, column: column ?? 1 } };
}

/** Dispatch the appropriate panel-open event based on file type. */
export function dispatchOpenFile(filePath: string, location?: FileLocation): void {
  if (filePath.endsWith(".md")) {
    dispatchLoxelEvent("loxel-open-markdown-editor", {
      filePath,
      line: location?.line,
      column: location?.column,
    });
  } else if (filePath.endsWith(".excalidraw")) {
    dispatchLoxelEvent("loxel-open-drawing-editor", { filePath });
  } else if (isMediaFile(filePath)) {
    dispatchLoxelEvent("loxel-open-media-viewer", { filePath });
  } else {
    dispatchLoxelEvent("loxel-open-code-editor", {
      filePath,
      line: location?.line,
      column: location?.column,
    });
  }
}
