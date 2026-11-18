import { EditorBanner } from "./EditorBanner";

interface SaveRefusedBannerProps {
  /** Why the server refused the save. */
  reason: string;
  onRetry: () => void;
  onDiscard: () => void;
  /** Names the file when the panel shows more than one (a compare panel) */
  fileName?: string;
}

/**
 * Shown above a file-backed editor whose save the server refused (a read-only file, say). The
 * edits stay in the editor and in the save outbox until a save goes through or they are
 * discarded, which loads the disk version.
 */
export function SaveRefusedBanner({
  reason,
  onRetry,
  onDiscard,
  fileName,
}: SaveRefusedBannerProps) {
  return (
    <EditorBanner
      tone="danger"
      message={`${fileName ?? "File"} could not be saved: ${reason.replace(/\.$/, "")}. Your changes stay here until it is saved.`}
      actions={[
        { label: "Try again", onClick: onRetry },
        { label: "Discard changes", onClick: onDiscard },
      ]}
    />
  );
}
