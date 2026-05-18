import path from "node:path";

import { createResult, runAction } from "@bizimind/cli-common";

import { cleanupBindings } from "../binding/arrow-binding.ts";
import { collectCascadeTargets } from "../elements/element-graph.ts";
import { findElementByIdOrThrow } from "../elements/element-query.ts";
import { bumpVersion, loadFile, saveFile } from "../file/excalidraw-file.ts";

interface DeleteOptions {
  json?: boolean;
  cascade?: boolean;
  cascadeArrows?: boolean;
  cascadeText?: boolean;
}

interface DeleteResult {
  deleted: string[];
}

export async function deleteCommand(
  filePath: string,
  ids: string[],
  opts: DeleteOptions,
): Promise<void> {
  await runAction<DeleteResult>(opts, async () => {
    const resolved = path.resolve(filePath);
    const file = await loadFile(resolved);

    // Validate all primary IDs exist first
    for (const id of ids) {
      findElementByIdOrThrow(file.elements, id);
    }

    const noCascade = opts.cascade === false;
    const cascadeText = !noCascade && opts.cascadeText !== false;
    const cascadeArrows = !noCascade && opts.cascadeArrows !== false;

    let allIds: string[];
    if (cascadeText || cascadeArrows) {
      allIds = [...collectCascadeTargets(file.elements, ids, { cascadeText, cascadeArrows })];
    } else {
      allIds = ids;
    }

    for (const id of allIds) {
      const el = file.elements.find((e) => e.id === id && !e.isDeleted);
      if (!el) continue; // may already be deleted by cascade
      el.isDeleted = true;
      bumpVersion(el);
      cleanupBindings(file.elements, id);
    }

    await saveFile(resolved, file);

    return createResult<DeleteResult>(
      { deleted: allIds },
      (r) => `Deleted ${r.deleted.length} element(s): ${r.deleted.join(", ")}`,
    );
  });
}
