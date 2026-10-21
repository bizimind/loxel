import { EditorBanner } from "./EditorBanner";

interface DeletedFileBannerProps {
  onRecreate: () => void;
  /** Names the file when the panel shows more than one (a compare panel) */
  fileName?: string;
}

/** Shown above a file-backed editor whose file no longer exists on disk. */
export function DeletedFileBanner({ onRecreate, fileName }: DeletedFileBannerProps) {
  return (
    <EditorBanner
      tone="danger"
      message={`${fileName ?? "File"} deleted from disk. Your changes stay here and are not saved until it exists again.`}
      actions={[{ label: "Re-create file", onClick: onRecreate }]}
    />
  );
}
