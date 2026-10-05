/**
 * Keystroke resolution with chord support. Shared by the document keydown listener and by
 * keystrokes the Electron main process forwards from webviews.
 *
 * A keystroke that starts (or continues) a bound chord is held as pending until the next key
 * completes it, any other key / Escape cancels it, or it times out.
 */

import { create } from "zustand";

import type { ActionId } from "./action-registry";
import { getActionDef } from "./action-registry";
import type { KeyCombo } from "./key-combo";
import { toKeyBinding } from "./key-combo";
import { useKeybindingStore } from "./keybinding-store";

/** How long a pressed chord prefix waits for the next key. */
export const CHORD_TIMEOUT_MS = 3000;

interface PendingChordState {
  /** Keystrokes of the chord typed so far; empty when no chord is in progress. */
  steps: readonly KeyCombo[];
}

export const usePendingChordStore = create<PendingChordState>(() => ({ steps: [] }));

export type KeystrokeResult =
  /** Not a binding — let the key through to the focused widget. */
  | { kind: "unbound" }
  /** Started or continued a chord — swallow the key and wait for the next one. */
  | { kind: "pending" }
  /** Ended a pending chord without a match (or Escape) — swallow the key. */
  | { kind: "cancelled" }
  /** Completed a binding — swallow the key and run the action. */
  | { kind: "action"; actionId: ActionId };

let timeout: ReturnType<typeof setTimeout> | null = null;

function setSteps(steps: readonly KeyCombo[]): void {
  if (timeout !== null) clearTimeout(timeout);
  timeout = steps.length > 0 ? setTimeout(cancelPendingChord, CHORD_TIMEOUT_MS) : null;
  usePendingChordStore.setState({ steps });
}

export function hasPendingChord(): boolean {
  return usePendingChordStore.getState().steps.length > 0;
}

export function cancelPendingChord(): void {
  if (hasPendingChord()) setSteps([]);
}

/**
 * A later chord step typed with ⌘ still held from a ⌘ leader ("⌘\ then ⌘→") also matches the
 * step without ⌘.
 */
function withoutLeaderCmd(pending: readonly KeyCombo[], combo: KeyCombo): KeyCombo | null {
  if (!pending[0]?.startsWith("Cmd+") || !combo.startsWith("Cmd+")) return null;
  return combo.slice("Cmd+".length) as KeyCombo;
}

/** Whether an action applies where focus is now (see `ActionDef.isEnabled`). */
export function isActionEnabledHere(actionId: ActionId): boolean {
  return getActionDef(actionId)?.isEnabled?.() ?? true;
}

/**
 * Resolve one keystroke against the active bindings, advancing chord state.
 * Tree actions are widget-local (handled by the focused tree), and actions disabled where focus
 * is resolve as unbound, so the key reaches the focused widget. A completed chord whose action is
 * disabled is cancelled instead (its first keys were already swallowed).
 * A single-key binding wins over a chord sharing the same first key (possible via overrides).
 */
export function resolveKeystroke(combo: KeyCombo): KeystrokeResult {
  const { lookup, chordPrefixes } = useKeybindingStore.getState();
  const pending = usePendingChordStore.getState().steps;

  if (pending.length === 0) {
    const actionId = lookup.get(combo);
    if (actionId?.startsWith("tree.")) return { kind: "unbound" };
    if (actionId) {
      return isActionEnabledHere(actionId) ? { kind: "action", actionId } : { kind: "unbound" };
    }
    if (chordPrefixes.has(combo)) {
      setSteps([combo]);
      return { kind: "pending" };
    }
    return { kind: "unbound" };
  }

  const candidates = [combo, withoutLeaderCmd(pending, combo)].filter(
    (c): c is KeyCombo => c !== null,
  );
  for (const step of candidates) {
    const sequence = toKeyBinding([...pending, step]);
    const actionId = lookup.get(sequence);
    if (actionId) {
      setSteps([]);
      return isActionEnabledHere(actionId) ? { kind: "action", actionId } : { kind: "cancelled" };
    }
    if (chordPrefixes.has(sequence)) {
      setSteps([...pending, step]);
      return { kind: "pending" };
    }
  }

  setSteps([]);
  return { kind: "cancelled" };
}
