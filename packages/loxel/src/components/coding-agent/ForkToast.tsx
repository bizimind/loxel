/**
 * Inline toast for fork tab choice.
 * Appears above the input area with keyboard-driven options.
 */
import { useEffect, useRef } from "react";

interface ForkToastProps {
  onNewTab: () => void;
  onHere: () => void;
  onCancel: () => void;
}

export function ForkToast({ onNewTab, onHere, onCancel }: ForkToastProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="bg-popover border-border flex items-center justify-center gap-4 border-t px-4 py-2 text-sm outline-none"
      onKeyDown={(e) => {
        if (e.key === "t" || e.key === "T") {
          e.preventDefault();
          onNewTab();
        } else if (e.key === "h" || e.key === "H") {
          e.preventDefault();
          onHere();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <span className="text-muted-foreground">Fork session:</span>
      <span className="flex items-center gap-1">
        <kbd className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-xs">
          T
        </kbd>
        <span>New tab</span>
      </span>
      <span className="flex items-center gap-1">
        <kbd className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-xs">
          H
        </kbd>
        <span>Here</span>
      </span>
      <span className="flex items-center gap-1">
        <kbd className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-xs">
          Esc
        </kbd>
        <span className="text-muted-foreground">Cancel</span>
      </span>
    </div>
  );
}
