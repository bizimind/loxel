/**
 * Inline key capture widget for remapping keybindings.
 * Renders a focused area that captures a key combo — or a chord of up to MAX_CHORD_STEPS
 * keystrokes — and previews it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { KeyBindingDisplay } from "@/components/ui/key-binding-display";
import type { ActionId } from "@/store/keybindings/action-registry";
import { getActionDef } from "@/store/keybindings/action-registry";
import type { KeyBinding, KeyCombo } from "@/store/keybindings/key-combo";
import { eventToKeyCombo, isModifierKey, toKeyBinding } from "@/store/keybindings/key-combo";
import { findOverlappingActions, useKeybindingStore } from "@/store/keybindings/keybinding-store";

/** Longest chord the recorder captures; the next key starts a new recording. */
const MAX_CHORD_STEPS = 3;

/**
 * Why a binding can't be saved, or null. Tree actions are resolved one keystroke at a time by the
 * focused tree; a chord must start with ⌘/⌃/⌥, or its first key could never be typed as text
 * (and would be withheld from web pages in browser panels).
 */
function bindingProblem(actionId: ActionId, steps: readonly KeyCombo[]): string | null {
  if (steps.length < 2) return null;
  if (actionId.startsWith("tree.")) return "Tree keys can't be chords";
  if (!/^(?:Cmd|Ctrl|Alt)\+/.test(steps[0]!)) return "Chords must start with ⌘, ⌃ or ⌥";
  return null;
}

interface KeyRecorderProps {
  actionId: ActionId;
  onConfirm: (bindings: KeyBinding[]) => void;
  onCancel: () => void;
}

export function KeyRecorder({ actionId, onConfirm, onCancel }: KeyRecorderProps) {
  const [steps, setSteps] = useState<KeyCombo[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const binding = steps.length > 0 ? toKeyBinding(steps) : null;
  const problem = bindingProblem(actionId, steps);
  const conflict = useMemo(
    () =>
      binding
        ? (findOverlappingActions(useKeybindingStore.getState(), actionId, binding)[0] ?? null)
        : null,
    [actionId, binding],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Ignore bare modifier presses
      if (isModifierKey(e.key)) return;
      // Ignore Escape — it cancels
      if (e.key === "Escape") {
        onCancel();
        return;
      }

      const combo = eventToKeyCombo(e.nativeEvent);
      setSteps((prev) => (prev.length >= MAX_CHORD_STEPS ? [combo] : [...prev, combo]));
    },
    [onCancel],
  );

  const handleConfirm = useCallback(() => {
    if (binding && !problem) onConfirm([binding]);
  }, [binding, problem, onConfirm]);

  return (
    <div className="flex items-center gap-2">
      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className="border-primary bg-muted text-foreground flex h-7 min-w-[140px] items-center rounded border px-2 text-xs ring-1 ring-blue-500/50 outline-none"
      >
        {binding ? (
          <KeyBindingDisplay binding={binding} className="text-xs" />
        ) : (
          <span className="text-muted-foreground">Press keys (more than one for a chord)...</span>
        )}
      </div>

      {problem && <span className="text-destructive text-xs">{problem}</span>}
      {!problem && conflict && (
        <span className="text-xs text-amber-500">
          Conflicts with "{getActionDef(conflict)?.label ?? conflict}"
        </span>
      )}

      <Button variant="ghost" size="xs" onClick={onCancel}>
        Cancel
      </Button>
      {steps.length > 0 && (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            setSteps([]);
            containerRef.current?.focus();
          }}
        >
          Clear
        </Button>
      )}
      <Button size="xs" disabled={!binding || problem !== null} onClick={handleConfirm}>
        {conflict ? "Reassign" : "Save"}
      </Button>
    </div>
  );
}
