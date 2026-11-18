import { ConflictBanner } from "@/components/editor/ConflictBanner";
import { DeletedFileBanner } from "@/components/editor/DeletedFileBanner";
import { SaveRefusedBanner } from "@/components/editor/SaveRefusedBanner";
import { getDisplayFilename } from "@/lib/detached-path";

import type { EditableSide } from "./use-editable-side";

/**
 * The editor-tab banners of an editable diff side, shown above the diff: its file was deleted
 * (offering to re-create it), changed on disk in a way that conflicts with unsaved edits, or
 * could not be saved because the server refused the write.
 */
export function EditableSideBanners({ side }: { side: EditableSide }) {
  const fileName = getDisplayFilename(side.filePath);
  return (
    <>
      {side.isDeleted && !side.loadFailed && (
        <DeletedFileBanner fileName={fileName} onRecreate={() => void side.recreateFile()} />
      )}
      {side.saveRefused !== null && !side.isDeleted && !side.isDiverged && (
        <SaveRefusedBanner
          fileName={fileName}
          reason={side.saveRefused}
          onRetry={() => void side.saveNow()}
          onDiscard={() => void side.discardEdits()}
        />
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
