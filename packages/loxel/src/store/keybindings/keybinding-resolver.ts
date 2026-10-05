/**
 * Keybinding resolver: builds a reverse lookup map from key bindings to action IDs.
 */

import type { ActionId } from "./action-registry";
import type { KeyBinding } from "./key-combo";
import { getBindingSteps, toKeyBinding } from "./key-combo";
import type { BindingTemplate } from "./keybinding-schema";

/**
 * Build a reverse lookup map (KeyBinding -> ActionId) from a template + user overrides.
 * For overridden actions, template bindings are replaced entirely.
 */
export function buildReverseLookup(
  template: BindingTemplate,
  overrides: Partial<Record<ActionId, readonly KeyBinding[]>>,
): Map<KeyBinding, ActionId> {
  const lookup = new Map<KeyBinding, ActionId>();

  for (const [actionId, bindings] of Object.entries(template)) {
    // Skip actions that have user overrides — they'll be applied below
    if (actionId in overrides) continue;
    for (const binding of bindings) {
      lookup.set(binding, actionId as ActionId);
    }
  }

  for (const [actionId, bindings] of Object.entries(overrides)) {
    if (!bindings) continue;
    for (const binding of bindings) {
      lookup.set(binding, actionId as ActionId);
    }
  }

  return lookup;
}

/**
 * Every strict chord prefix of the bound chords ("Cmd+Backslash", "Cmd+Backslash T" for
 * "Cmd+Backslash T ArrowRight"). A keystroke sequence in this set waits for the next key.
 */
export function buildChordPrefixes(lookup: ReadonlyMap<KeyBinding, ActionId>): Set<KeyBinding> {
  const prefixes = new Set<KeyBinding>();
  for (const binding of lookup.keys()) {
    const steps = getBindingSteps(binding);
    for (let i = 1; i < steps.length; i++) {
      prefixes.add(toKeyBinding(steps.slice(0, i)));
    }
  }
  return prefixes;
}
