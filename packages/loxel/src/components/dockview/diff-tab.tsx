import type { IDockviewPanelHeaderProps } from "dockview-react";
import { DiffIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { workingTreeSideKey } from "@/components/diff/use-editable-side";
import { useDiffTitle } from "@/hooks/useDiffTitle";
import type { PatchDiffParams } from "@/lib/panel-creators";
import { useEditorStateStore } from "@/store/editor-state";
import { useWorktreeUI } from "@/store/worktree-ui";
import { useWorktreeStore } from "@/store/worktrees";

import { DELETED_TAB_TITLE_CLASS, DivergedDot, Tab, usePanelTitle } from "./tab";

/**
 * Tab of the diff viewer. While the shown file's working-tree side is edited in place, it has the
 * conflict dot and deleted-file styling of editor tabs.
 */
export function DiffTab(props: IDockviewPanelHeaderProps) {
  const diffTitle = useDiffTitle();
  const [title, setTitle] = useState(diffTitle);

  useEffect(() => {
    setTitle(diffTitle);
    props.api.setTitle(diffTitle);
  }, [diffTitle, props.api]);

  const worktreePath = useWorktreeStore((s) => s.activeWorktreePath);
  const selectedFile = useWorktreeUI((s) => s.selectedDiffFile);
  const key =
    worktreePath && selectedFile ? workingTreeSideKey(`${worktreePath}/${selectedFile}`) : null;
  const isDiverged = useEditorStateStore(
    (s) => key !== null && s.files.get(key)?.state === "diverged",
  );
  const isDeleted = useEditorStateStore((s) => key !== null && !!s.files.get(key)?.deleted);

  return (
    <Tab
      api={props.api}
      icon={<DiffIcon className="size-3.5 shrink-0" />}
      title={title}
      leading={isDiverged ? <DivergedDot title="The edited file changed on disk" /> : null}
      titleClassName={isDeleted ? DELETED_TAB_TITLE_CLASS : undefined}
      titleTooltip={isDeleted ? "The edited file was deleted from disk" : undefined}
    />
  );
}

/** Tab of a patch's diff panel: the title it opened with, and the file the patch came from. */
export function PatchDiffTab(props: IDockviewPanelHeaderProps<PatchDiffParams>) {
  return (
    <Tab
      api={props.api}
      icon={<DiffIcon className="size-3.5 shrink-0" />}
      title={usePanelTitle(props.api) ?? "Patch"}
      titleTooltip={`Patch from ${props.params.sourcePath}`}
    />
  );
}
