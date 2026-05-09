/**
 * Compact rewind/fork action buttons shown on the left side of timeline items.
 * Icon-only, vertically stacked, visible on hover.
 */
import { GitFork, Undo2 } from "lucide-react";

interface MessageActionsProps {
  disabled?: boolean;
  onRewind: () => void;
  onFork: () => void;
}

export function MessageActions({ disabled, onRewind, onFork }: MessageActionsProps) {
  if (disabled) return <div className="w-10 shrink-0" />;

  return (
    <div className="flex shrink-0 items-start gap-1 opacity-0 transition-opacity group-hover/row:opacity-100">
      <button
        type="button"
        onClick={onRewind}
        className="border-border bg-muted text-foreground hover:bg-primary hover:text-primary-foreground rounded border p-0.5 transition-colors"
        title="Rewind to here"
      >
        <Undo2 className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onFork}
        className="border-border bg-muted text-foreground hover:bg-primary hover:text-primary-foreground rounded border p-0.5 transition-colors"
        title="Fork from here"
      >
        <GitFork className="size-3.5" />
      </button>
    </div>
  );
}
