import { cn } from "@/lib/utils";

interface ConflictBannerProps {
  onAcceptDisk: () => void;
  onKeepMine: () => void;
}

export function ConflictBanner({ onAcceptDisk, onKeepMine }: ConflictBannerProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b px-3 py-1.5 text-xs",
        "border-yellow-600/50 bg-yellow-900/50 text-yellow-200",
      )}
    >
      <span className="flex-1">File changed on disk by another process.</span>
      <button
        onClick={onAcceptDisk}
        className="rounded bg-yellow-700/60 px-2 py-0.5 hover:bg-yellow-700/80"
      >
        Accept disk version
      </button>
      <button
        onClick={onKeepMine}
        className="rounded bg-yellow-700/60 px-2 py-0.5 hover:bg-yellow-700/80"
      >
        Keep my changes
      </button>
    </div>
  );
}
