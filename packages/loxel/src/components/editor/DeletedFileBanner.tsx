import { dispatchLoxelEvent } from "@/lib/loxel-events";

import { EditorBanner } from "./EditorBanner";

interface DeletedFileBannerProps {
  /** The deleted file's absolute path. */
  filePath: string;
  onRecreate: () => void;
  /** Names the file when the panel shows more than one (a compare panel) */
  fileName?: string;
}

/**
 * Shown above a file-backed editor whose file no longer exists on disk. Discarding the changes
 * closes the file's tabs and gives up its unsaved edits, as deleting the file in Loxel does: they
 * are otherwise kept, even after the tab closes, until the file exists again.
 */
export function DeletedFileBanner({ filePath, onRecreate, fileName }: DeletedFileBannerProps) {
  return (
    <EditorBanner
      tone="danger"
      message={`${fileName ?? "File"} deleted from disk. Your changes stay here and are not saved until it exists again.`}
      actions={[
        { label: "Re-create file", onClick: onRecreate },
        {
          label: "Discard changes",
          onClick: () => dispatchLoxelEvent("loxel-file-deleted", { filePath }),
        },
      ]}
    />
  );
}
