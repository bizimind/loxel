import path from "node:path";

import { createResult, runAction } from "@bizimind/cli-common";

import { findElementByIdOrThrow } from "../elements/element-query.ts";
import { bumpVersion, loadFile, saveFile } from "../file/excalidraw-file.ts";

interface ResizeOptions {
  width?: number;
  height?: number;
  scale?: number;
  json?: boolean;
}

interface ResizeResult {
  id: string;
  width: number;
  height: number;
}

export async function resizeCommand(
  filePath: string,
  id: string,
  opts: ResizeOptions,
): Promise<void> {
  await runAction<ResizeResult>(opts, async () => {
    if (opts.width === undefined && opts.height === undefined && opts.scale === undefined) {
      throw new Error("Specify --width, --height, or --scale");
    }

    const resolved = path.resolve(filePath);
    const file = await loadFile(resolved);
    const el = findElementByIdOrThrow(file.elements, id);

    if (opts.scale !== undefined) {
      if (opts.scale <= 0) throw new Error("Scale must be a positive number");
      el.width = el.width * opts.scale;
      el.height = el.height * opts.scale;
    } else {
      if (opts.width !== undefined) el.width = opts.width;
      if (opts.height !== undefined) el.height = opts.height;
    }

    bumpVersion(el);
    await saveFile(resolved, file);

    return createResult<ResizeResult>(
      { id: el.id, width: Math.round(el.width), height: Math.round(el.height) },
      (r) => `Resized ${r.id} to ${r.width}x${r.height}`,
    );
  });
}
