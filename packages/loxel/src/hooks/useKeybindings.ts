/**
 * Global keybinding listener. Wire into App.tsx once.
 * Captures keydown events at the document level (capture phase), plus bound keystrokes the
 * Electron main process forwards from webviews, resolves them (including chords) via the
 * keybinding store, and dispatches the resulting actions.
 */

import { useEffect } from "react";

import type { KeyCombo } from "@/store/keybindings/key-combo";
import { eventToKeyCombo, getBindingSteps, isModifierKey } from "@/store/keybindings/key-combo";
import { useKeybindingStore } from "@/store/keybindings/keybinding-store";
import {
  cancelPendingChord,
  hasPendingChord,
  resolveKeystroke,
  usePendingChordStore,
} from "@/store/keybindings/pending-chord";
import { useSettingsStore } from "@/store/settings-store";

import { useActionHandler } from "./useActionHandler";

function isTextInput(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

/** First keystroke of every non-tree binding — what the main process withholds from webviews. */
function firstKeystrokes(): string[] {
  const firstSteps = new Set<string>();
  for (const [binding, actionId] of useKeybindingStore.getState().lookup) {
    if (!actionId.startsWith("tree.")) firstSteps.add(getBindingSteps(binding)[0]!);
  }
  return [...firstSteps];
}

/**
 * Tell the main process which webview keystrokes to forward: the first keystroke of each
 * binding, or every keystroke while a chord is in progress (its next key may be any key).
 */
function syncWebviewInterception(): void {
  window.electronAPI?.setKeystrokeInterception({
    combos: firstKeystrokes(),
    captureAll: hasPendingChord(),
  });
}

export function useKeybindings(): void {
  const dispatch = useActionHandler();

  useEffect(() => {
    /** Resolve one keystroke. Returns whether it was consumed (must not reach the page). */
    function handleKeystroke(combo: KeyCombo, isRepeat: boolean): boolean {
      // Holding a chord's key past the repeat delay must not advance (and cancel) the chord.
      if (isRepeat && hasPendingChord()) return true;
      const result = resolveKeystroke(combo);
      if (result.kind === "action") dispatch(result.actionId);
      return result.kind !== "unbound";
    }

    function handleKeyDown(e: KeyboardEvent) {
      // Skip when settings modal is open — allows KeyRecorder to capture bound combos
      if (useSettingsStore.getState().isOpen) {
        cancelPendingChord();
        return;
      }
      if (e.isComposing || isModifierKey(e.key)) return;

      // Don't intercept bare keypresses in text inputs — only modifier combos — unless they
      // complete a chord in progress.
      if (!hasPendingChord() && isTextInput(e.target) && !e.metaKey && !e.ctrlKey) return;

      if (!handleKeystroke(eventToKeyCombo(e), e.repeat)) return;
      e.preventDefault();
      e.stopPropagation();
    }

    function handleWebviewKeystroke(combo: unknown, isRepeat: unknown) {
      if (typeof combo !== "string" || useSettingsStore.getState().isOpen) return;
      handleKeystroke(combo as KeyCombo, isRepeat === true);
    }

    const offWebviewKeystroke = window.electronAPI?.onWebviewKeystroke(handleWebviewKeystroke);
    const offLookup = useKeybindingStore.subscribe((state, prev) => {
      if (state.lookup !== prev.lookup) syncWebviewInterception();
    });
    const offChord = usePendingChordStore.subscribe((state, prev) => {
      if (state.steps.length > 0 !== prev.steps.length > 0) syncWebviewInterception();
    });
    syncWebviewInterception();

    // Capture phase ensures this fires before component-level handlers
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("blur", cancelPendingChord);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", cancelPendingChord);
      offWebviewKeystroke?.();
      offLookup();
      offChord();
    };
  }, [dispatch]);
}
