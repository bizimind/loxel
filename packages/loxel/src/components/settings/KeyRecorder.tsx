/**
 * Inline key capture widget for remapping keybindings.
 * Renders a focused area that captures the next key combo and previews it.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { ActionId } from "@/store/keybindings/action-registry";
import type { KeyCombo } from "@/store/keybindings/keybinding-schema";

import { Button } from "@/components/ui/button";
import { KeyComboDisplay } from "@/components/ui/key-combo-display";
import { getActionDef } from "@/store/keybindings/action-registry";
import { eventToKeyCombo } from "@/store/keybindings/keybinding-schema";
import { useKeybindingStore } from "@/store/keybindings/keybinding-store";

interface KeyRecorderProps {
  actionId: ActionId;
  onConfirm: (combos: KeyCombo[]) => void;
  onCancel: () => void;
}

export function KeyRecorder({ actionId, onConfirm, onCancel }: KeyRecorderProps) {
  const [captured, setCaptured] = useState<KeyCombo | null>(null);
  const [conflict, setConflict] = useState<ActionId | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Ignore bare modifier presses
      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
      // Ignore Escape — it cancels
      if (e.key === "Escape") {
        onCancel();
        return;
      }

      const combo = eventToKeyCombo(e.nativeEvent);
      setCaptured(combo);

      // Check for conflicts
      const lookup = useKeybindingStore.getState().lookup;
      const existing = lookup.get(combo);
      setConflict(existing && existing !== actionId ? existing : null);
    },
    [actionId, onCancel],
  );

  const handleConfirm = useCallback(() => {
    if (captured) onConfirm([captured]);
  }, [captured, onConfirm]);

  return (
    <div className="flex items-center gap-2">
      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className="border-primary bg-muted text-foreground flex h-7 min-w-[140px] items-center rounded border px-2 text-xs ring-1 ring-blue-500/50 outline-none"
      >
        {captured ? (
          <KeyComboDisplay combo={captured} className="text-xs" />
        ) : (
          <span className="text-muted-foreground">Press a key combo...</span>
        )}
      </div>

      {conflict && (
        <span className="text-xs text-amber-500">
          Conflicts with "{getActionDef(conflict)?.label ?? conflict}"
        </span>
      )}

      <Button variant="ghost" size="xs" onClick={onCancel}>
        Cancel
      </Button>
      <Button size="xs" disabled={!captured} onClick={handleConfirm}>
        {conflict ? "Reassign" : "Save"}
      </Button>
    </div>
  );
}
