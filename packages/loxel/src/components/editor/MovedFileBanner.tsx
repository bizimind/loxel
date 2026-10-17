import type { DockviewPanelApi } from "dockview-react";

import { usePanelWorktreePath } from "@/components/dockview/panel-context";
import { relativeTo } from "@/lib/project-file-helpers";

import { EditorBanner } from "./EditorBanner";

interface MovedFileBannerProps {
  /** The tab's `movedFrom` parameter: the file's previous path, set by `handleFileMoved`. */
  movedFrom: string | undefined;
  filePath: string;
  panelApi: DockviewPanelApi;
}

/**
 * Shown above an editor whose file was renamed or moved outside Loxel, with the old and new
 * path. The tab already follows the file; Dismiss clears the tab parameter.
 */
export function MovedFileBanner({ movedFrom, filePath, panelApi }: MovedFileBannerProps) {
  const worktreePath = usePanelWorktreePath();
  if (!movedFrom) return null;

  const display = (path: string) =>
    (worktreePath ? relativeTo(path, worktreePath) : undefined) ?? path;
  return (
    <EditorBanner
      tone="info"
      message={
        <>
          File moved outside Loxel from <code>{display(movedFrom)}</code> to{" "}
          <code>{display(filePath)}</code>.
        </>
      }
      actions={[
        { label: "Dismiss", onClick: () => panelApi.updateParameters({ movedFrom: undefined }) },
      ]}
    />
  );
}
