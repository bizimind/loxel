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

/** The kind of center panel that opens a file, by its extension. */
export type FilePanelType = "editor" | "codeEditor" | "excalidraw" | "media";

export function filePanelType(filePath: string): FilePanelType {
  if (filePath.endsWith(".md")) return "editor";
  if (filePath.endsWith(".excalidraw")) return "excalidraw";
  if (isMediaFile(filePath)) return "media";
  return "codeEditor";
}

/** Dispatch the appropriate panel-open event based on file type. */
export function dispatchOpenFile(filePath: string, location?: FileLocation): void {
  const type = filePanelType(filePath);
  switch (type) {
    case "editor":
      dispatchLoxelEvent("loxel-open-markdown-editor", {
        filePath,
        line: location?.line,
        column: location?.column,
      });
      break;
    case "excalidraw":
      dispatchLoxelEvent("loxel-open-drawing-editor", { filePath });
      break;
    case "media":
      dispatchLoxelEvent("loxel-open-media-viewer", { filePath });
      break;
    case "codeEditor":
      dispatchLoxelEvent("loxel-open-code-editor", {
        filePath,
        line: location?.line,
        column: location?.column,
      });
      break;
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown file panel type: ${String(_exhaustive)}`);
    }
  }
}
