import { EditorBanner } from "./EditorBanner";

interface DeletedFileBannerProps {
  onRecreate: () => void;
}

/** Shown above a file-backed editor whose file no longer exists on disk. */
export function DeletedFileBanner({ onRecreate }: DeletedFileBannerProps) {
  return (
    <EditorBanner
      tone="danger"
      message="File deleted from disk. Your changes stay here and are not saved until it exists again."
      actions={[{ label: "Re-create file", onClick: onRecreate }]}
    />
  );
}
