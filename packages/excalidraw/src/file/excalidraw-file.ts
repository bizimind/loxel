import type { ExcalidrawElement } from "../elements/excalidraw-types.ts";

export interface ExcalidrawFile {
  type: "excalidraw";
  version: number;
  source: string;
  elements: ExcalidrawElement[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

export function createEmptyFile(bgColor = "#ffffff"): ExcalidrawFile {
  return {
    type: "excalidraw",
    version: 2,
    source: "excalidraw-cli",
    elements: [],
    appState: { gridSize: null, viewBackgroundColor: bgColor },
    files: {},
  };
}

export async function loadFile(filePath: string): Promise<ExcalidrawFile> {
  const file = Bun.file(filePath);
  const exists = await file.exists();
  if (!exists) {
    throw new Error(`File not found: ${filePath}. Use 'excalidraw create -f ${filePath}' first.`);
  }
  const text = await file.text();
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== "object" || !("type" in data) || data.type !== "excalidraw") {
    throw new Error(`Invalid excalidraw file: ${filePath}`);
  }
  const doc = data as Record<string, unknown>;
  return {
    type: "excalidraw",
    version: typeof doc.version === "number" ? doc.version : 2,
    source: typeof doc.source === "string" ? doc.source : "unknown",
    elements: Array.isArray(doc.elements) ? (doc.elements as ExcalidrawElement[]) : [],
    appState:
      typeof doc.appState === "object" && doc.appState !== null
        ? (doc.appState as Record<string, unknown>)
        : {},
    files:
      typeof doc.files === "object" && doc.files !== null
        ? (doc.files as Record<string, unknown>)
        : {},
  };
}

export async function saveFile(filePath: string, file: ExcalidrawFile): Promise<void> {
  const json = JSON.stringify(file, null, 2);
  await Bun.write(filePath, json);
}

/** Bump version and versionNonce on a mutated element */
export function bumpVersion(el: ExcalidrawElement): void {
  el.version = ((el.version as number) ?? 0) + 1;
  el.versionNonce = Math.floor(Math.random() * 2_000_000_000);
  el.updated = Date.now();
}
