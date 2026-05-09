import { createResult, runAction } from "@bizimind/cli-common";
import path from "node:path";

import { generateElementId } from "../elements/element-id.ts";
import { filterByGroupId, findElementByIdOrThrow } from "../elements/element-query.ts";
import { bumpVersion, loadFile, saveFile } from "../file/excalidraw-file.ts";

interface GroupOptions {
  json?: boolean;
}

interface GroupResult {
  groupId: string;
  elementIds: string[];
}

export async function groupCommand(
  filePath: string,
  ids: string[],
  opts: GroupOptions,
): Promise<void> {
  await runAction<GroupResult>(opts, async () => {
    if (ids.length < 2) throw new Error("At least 2 element IDs required for grouping");

    const resolved = path.resolve(filePath);
    const file = await loadFile(resolved);
    const groupId = `grp_${generateElementId()}`;

    for (const id of ids) {
      const el = findElementByIdOrThrow(file.elements, id);
      const groupIds = (el.groupIds as string[]) ?? [];
      groupIds.push(groupId);
      el.groupIds = groupIds;
      bumpVersion(el);
    }

    await saveFile(resolved, file);

    return createResult<GroupResult>(
      { groupId, elementIds: ids },
      (r) => `Grouped ${r.elementIds.length} elements as ${r.groupId}`,
    );
  });
}

interface UngroupResult {
  groupId: string;
  elementIds: string[];
}

export async function ungroupCommand(
  filePath: string,
  groupId: string,
  opts: GroupOptions,
): Promise<void> {
  await runAction<UngroupResult>(opts, async () => {
    const resolved = path.resolve(filePath);
    const file = await loadFile(resolved);

    const members = filterByGroupId(file.elements, groupId);
    if (members.length === 0) throw new Error(`Group not found: ${groupId}`);

    const memberIds: string[] = [];
    for (const el of members) {
      const groupIds = (el.groupIds as string[]) ?? [];
      el.groupIds = groupIds.filter((gid) => gid !== groupId);
      bumpVersion(el);
      memberIds.push(el.id);
    }

    await saveFile(resolved, file);

    return createResult<UngroupResult>(
      { groupId, elementIds: memberIds },
      (r) => `Ungrouped ${r.groupId}: ${r.elementIds.length} elements released`,
    );
  });
}
