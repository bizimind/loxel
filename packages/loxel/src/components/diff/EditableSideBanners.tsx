import { ConflictBanner } from "@/components/editor/ConflictBanner";
import { DeletedFileBanner } from "@/components/editor/DeletedFileBanner";
import { getDisplayFilename } from "@/lib/detached-path";

import type { EditableSide } from "./use-editable-side";

/**
 * The editor-tab banners of an editable diff side, shown above the diff: its file was deleted
 * (offering to re-create it), or changed on disk in a way that conflicts with unsaved edits.
 */
export function EditableSideBanners({ side }: { side: EditableSide }) {
  const fileName = getDisplayFilename(side.filePath);
  return (
    <>
      {side.isDeleted && !side.loadFailed && (
        <DeletedFileBanner fileName={fileName} onRecreate={() => void side.recreateFile()} />
      )}
      {side.isDiverged && (
        <ConflictBanner
          fileName={fileName}
          onAcceptDisk={side.acceptDisk}
          onKeepMine={side.keepMine}
        />
      )}
    </>
  );
}
