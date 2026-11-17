import { dispatchLoxelEvent } from "@/lib/loxel-events";

import { EditorBanner } from "./EditorBanner";

interface DeletedFileBannerProps {
  /**
   * The deleted file's absolute path, for the file's own tab: offers to discard the edits, which
   * are otherwise kept until the file exists again, even after the tab closes.
   */
  filePath?: string;
  onRecreate: () => void;
  /** Names the file when the panel shows more than one (a compare panel) */
  fileName?: string;
}

/**
 * Shown above a file-backed editor whose file no longer exists on disk. Discarding the changes
 * closes the file's tabs and gives up its unsaved edits, as deleting the file in Loxel does.
 */
export function DeletedFileBanner({ filePath, onRecreate, fileName }: DeletedFileBannerProps) {
  return (
    <EditorBanner
      tone="danger"
      message={`${fileName ?? "File"} deleted from disk. Your changes stay here and are not saved until it exists again.`}
      actions={[
        { label: "Re-create file", onClick: onRecreate },
        ...(filePath
          ? [
              {
                label: "Discard changes",
                onClick: () => dispatchLoxelEvent("loxel-file-deleted", { filePath }),
              },
            ]
          : []),
      ]}
    />
  );
}
