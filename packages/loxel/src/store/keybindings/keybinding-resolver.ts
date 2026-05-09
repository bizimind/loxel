/**
 * Keybinding resolver: builds a reverse lookup map from key combos to action IDs.
 */

import type { ActionId } from "./action-registry";
import type { BindingTemplate, KeyCombo } from "./keybinding-schema";

/**
 * Build a reverse lookup map (KeyCombo -> ActionId) from a template + user overrides.
 * For overridden actions, template bindings are replaced entirely.
 */
export function buildReverseLookup(
  template: BindingTemplate,
  overrides: Partial<Record<ActionId, readonly KeyCombo[]>>,
): Map<KeyCombo, ActionId> {
  const lookup = new Map<KeyCombo, ActionId>();

  for (const [actionId, combos] of Object.entries(template)) {
    // Skip actions that have user overrides — they'll be applied below
    if (actionId in overrides) continue;
    for (const combo of combos) {
      lookup.set(combo, actionId as ActionId);
    }
  }

  for (const [actionId, combos] of Object.entries(overrides)) {
    if (!combos) continue;
    for (const combo of combos) {
      lookup.set(combo, actionId as ActionId);
    }
  }

  return lookup;
}
