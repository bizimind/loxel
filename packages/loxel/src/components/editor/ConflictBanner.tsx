import { EditorBanner } from "./EditorBanner";

interface ConflictBannerProps {
  onAcceptDisk: () => void;
  onKeepMine: () => void;
  /** Names the file when the panel shows more than one (a compare panel) */
  fileName?: string;
}

export function ConflictBanner({ onAcceptDisk, onKeepMine, fileName }: ConflictBannerProps) {
  return (
    <EditorBanner
      tone="warning"
      message={`${fileName ?? "File"} changed on disk by another process.`}
      actions={[
        { label: "Accept disk version", onClick: onAcceptDisk },
        { label: "Keep my changes", onClick: onKeepMine },
      ]}
    />
  );
}
