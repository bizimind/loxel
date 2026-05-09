/**
 * Global keybinding listener. Wire into App.tsx once.
 * Captures keydown events at the document level (capture phase),
 * resolves to actions via the keybinding store, and dispatches them.
 */

import { useEffect } from "react";

import { eventToKeyCombo } from "@/store/keybindings/keybinding-schema";
import { useKeybindingStore } from "@/store/keybindings/keybinding-store";
import { useSettingsStore } from "@/store/settings-store";

import { useActionHandler } from "./useActionHandler";

function isTextInput(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

export function useKeybindings(): void {
  const dispatch = useActionHandler();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Skip when settings modal is open — allows KeyRecorder to capture bound combos
      if (useSettingsStore.getState().isOpen) return;

      // Don't intercept bare keypresses in text inputs — only modifier combos
      if (isTextInput(e.target) && !e.metaKey && !e.ctrlKey) return;

      // Skip bare modifier key presses
      if (e.key === "Meta" || e.key === "Control" || e.key === "Alt" || e.key === "Shift") return;

      const combo = eventToKeyCombo(e);
      const actionId = useKeybindingStore.getState().lookup.get(combo);

      if (actionId) {
        if (actionId.startsWith("tree.")) return;
        e.preventDefault();
        e.stopPropagation();
        dispatch(actionId);
      }
    }

    // Capture phase ensures this fires before component-level handlers
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [dispatch]);
}
