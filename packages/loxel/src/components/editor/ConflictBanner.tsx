import { EditorBanner } from "./EditorBanner";

interface ConflictBannerProps {
  onAcceptDisk: () => void;
  onKeepMine: () => void;
}

export function ConflictBanner({ onAcceptDisk, onKeepMine }: ConflictBannerProps) {
  return (
    <EditorBanner
      tone="warning"
      message="File changed on disk by another process."
      actions={[
        { label: "Accept disk version", onClick: onAcceptDisk },
        { label: "Keep my changes", onClick: onKeepMine },
      ]}
    />
  );
}
