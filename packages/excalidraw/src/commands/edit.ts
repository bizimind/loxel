import path from "node:path";

import { createResult, runAction } from "@bizimind/cli-common";

import { withDom } from "../dom-shim.ts";
import { FONT_FAMILIES, type FontFamilyName } from "../elements/element-defaults.ts";
import { buildContainerSkeleton, convertSkeletons } from "../elements/element-factory.ts";
import { findElementByIdOrThrow } from "../elements/element-query.ts";
import { bumpVersion, loadFile, saveFile } from "../file/excalidraw-file.ts";

interface EditOptions {
  stroke?: string;
  bg?: string;
  fill?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  roughness?: number;
  opacity?: number;
  round?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  locked?: boolean;
  unlocked?: boolean;
  json?: boolean;
}

interface EditResult {
  id: string;
  type: string;
  updated: string[];
}

/** Maps CLI flag names to Excalidraw element property names for style edits. */
export const STYLE_PROPS: ReadonlyArray<{ flag: string; prop: string }> = [
  { flag: "stroke", prop: "strokeColor" },
  { flag: "bg", prop: "backgroundColor" },
  { flag: "fill", prop: "fillStyle" },
  { flag: "strokeWidth", prop: "strokeWidth" },
  { flag: "strokeStyle", prop: "strokeStyle" },
  { flag: "roughness", prop: "roughness" },
  { flag: "opacity", prop: "opacity" },
];

export async function editCommand(filePath: string, id: string, opts: EditOptions): Promise<void> {
  await runAction<EditResult>(opts, async () => {
    const resolved = path.resolve(filePath);
    const file = await loadFile(resolved);
    const el = findElementByIdOrThrow(file.elements, id);
    const updated: string[] = [];

    // Apply style properties
    const optRecord = opts as Record<string, unknown>;
    for (const { flag, prop } of STYLE_PROPS) {
      if (optRecord[flag] !== undefined) {
        el[prop] = optRecord[flag];
        updated.push(prop);
      }
    }

    // Roundness
    if (opts.round !== undefined) {
      el.roundness = opts.round > 0 ? { type: 3 } : null;
      updated.push("roundness");
    }

    // Text content — for text elements, set directly; for containers, set/create bound text
    if (opts.text !== undefined) {
      if (el.type === "text") {
        el.text = opts.text;
        el.originalText = opts.text;
        updated.push("text");
      } else {
        const bound = (el.boundElements as Array<{ id: string; type: string }>) ?? [];
        const existingTextBinding = bound.find((b) => b.type === "text");
        if (existingTextBinding) {
          const textEl = file.elements.find((e) => e.id === existingTextBinding.id);
          if (textEl) {
            textEl.text = opts.text;
            textEl.originalText = opts.text;
            bumpVersion(textEl);
            updated.push("text");
          }
        } else {
          // Create a temporary container skeleton with text to get proper binding
          const tempSkeleton = buildContainerSkeleton(
            el.type as "rectangle" | "ellipse" | "diamond",
            { x: el.x, y: el.y, width: el.width, height: el.height, text: opts.text },
          );
          tempSkeleton.id = el.id;
          const converted = await withDom(() => convertSkeletons([tempSkeleton]));
          const addedText = converted.find((e) => e.type === "text");
          if (addedText) {
            file.elements.push(addedText);
            const containerFromConverted = converted.find((e) => e.id === el.id);
            if (containerFromConverted) {
              el.boundElements = containerFromConverted.boundElements;
            }
            updated.push("text");
          }
        }
      }
    }

    if (opts.fontSize !== undefined && el.type === "text") {
      el.fontSize = opts.fontSize;
      updated.push("fontSize");
    }

    if (opts.fontFamily !== undefined && el.type === "text") {
      const family = FONT_FAMILIES[opts.fontFamily as FontFamilyName];
      if (!family)
        throw new Error(`Invalid font family: ${opts.fontFamily}. Use: hand, normal, code`);
      el.fontFamily = family;
      updated.push("fontFamily");
    }

    // Lock/unlock
    if (opts.locked) {
      el.locked = true;
      updated.push("locked");
    }
    if (opts.unlocked) {
      el.locked = false;
      updated.push("locked");
    }

    bumpVersion(el);
    await saveFile(resolved, file);

    return createResult<EditResult>(
      { id: el.id, type: el.type as string, updated },
      (r) => `Updated ${r.type} ${r.id}: ${r.updated.join(", ")}`,
    );
  });
}
