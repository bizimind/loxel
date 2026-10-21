import type { IDockviewPanelHeaderProps } from "dockview-react";
import { ArrowLeftRightIcon } from "lucide-react";

import { compareSideKey } from "@/components/compare/use-compare-side";
import { getDisplayFilename } from "@/lib/detached-path";
import { useEditorStateStore } from "@/store/editor-state";

import { Tab } from "./tab";

/**
 * Tab of a compare panel: both file names, with the conflict dot and deleted-file styling of
 * editor tabs when either side has them.
 */
export function CompareTab(props: IDockviewPanelHeaderProps<{ oldPath: string; newPath: string }>) {
  const { oldPath, newPath } = props.params;
  const keys = [compareSideKey(props.api.id, "old"), compareSideKey(props.api.id, "new")];
  const isDiverged = useEditorStateStore((s) =>
    keys.some((key) => s.files.get(key)?.state === "diverged"),
  );
  const isDeleted = useEditorStateStore((s) => keys.some((key) => s.files.get(key)?.deleted));

  return (
    <Tab
      api={props.api}
      icon={<ArrowLeftRightIcon className="size-3.5 shrink-0" />}
      title={`${getDisplayFilename(oldPath)} ↔ ${getDisplayFilename(newPath)}`}
      leading={
        isDiverged ? (
          <span
            className="inline-block size-2 shrink-0 rounded-full bg-yellow-500"
            title="A compared file changed on disk"
          />
        ) : null
      }
      titleClassName={isDeleted ? "line-through opacity-50" : undefined}
      titleTooltip={isDeleted ? "A compared file was deleted from disk" : `${oldPath}\n${newPath}`}
    />
  );
}
