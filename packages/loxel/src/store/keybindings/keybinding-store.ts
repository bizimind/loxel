/**
 * Keybinding store: persists selected template and user overrides.
 * The reverse lookup map is derived (not persisted) and rebuilt on changes.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { STORAGE_PREFIX } from "@/lib/env";

import { serverKeybindingsStorage } from "../server-storage";
import type { ActionId } from "./action-registry";
import { ACTION_IDS } from "./action-registry";
import { buildReverseLookup } from "./keybinding-resolver";
import type { BindingTemplate, KeyCombo, TemplateName } from "./keybinding-schema";
import { TEMPLATES, normalizeKeyCombo } from "./keybinding-schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KeybindingState {
  /** Which template profile is active. */
  activeTemplate: TemplateName;

  /** User overrides — only contains actions the user has explicitly remapped. */
  overrides: Partial<Record<ActionId, readonly KeyCombo[]>>;

  /** Reverse lookup: key combo -> action ID. Derived, not persisted. */
  lookup: Map<KeyCombo, ActionId>;

  // Actions
  setTemplate: (name: TemplateName) => void;
  setOverride: (actionId: ActionId, combos: KeyCombo[]) => void;
  removeOverride: (actionId: ActionId) => void;
  resetAllOverrides: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rebuild(
  template: TemplateName,
  overrides: Partial<Record<ActionId, readonly KeyCombo[]>>,
) {
  return buildReverseLookup(TEMPLATES[template], overrides);
}

/** Get the effective bindings for an action (template + overrides merged). */
export function getBindingsForAction(
  state: KeybindingState,
  actionId: ActionId,
): readonly KeyCombo[] {
  if (actionId in state.overrides) return state.overrides[actionId] ?? [];
  return TEMPLATES[state.activeTemplate][actionId] ?? [];
}

/** Get the full effective binding template (template merged with overrides). */
export function getEffectiveTemplate(state: KeybindingState): BindingTemplate {
  const base = TEMPLATES[state.activeTemplate];
  return { ...base, ...state.overrides } as BindingTemplate;
}

/** Check if an action has a user override. */
export function hasOverride(state: KeybindingState, actionId: ActionId): boolean {
  return actionId in state.overrides;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useKeybindingStore = create<KeybindingState>()(
  persist(
    (set, get) => ({
      activeTemplate: "loxel" as TemplateName,
      overrides: {},
      lookup: rebuild("loxel", {}),

      setTemplate: (name) => {
        set({ activeTemplate: name, lookup: rebuild(name, get().overrides) });
      },

      setOverride: (actionId, combos) => {
        const overrides = { ...get().overrides, [actionId]: combos };
        const comboSet = new Set(combos.map((c) => c as string));

        // Remove conflicting combos from other overridden actions
        for (const [otherId, otherCombos] of Object.entries(overrides)) {
          if (otherId === actionId || !otherCombos) continue;
          const filtered = otherCombos.filter((c) => !comboSet.has(c as string));
          if (filtered.length !== otherCombos.length) {
            overrides[otherId as ActionId] = filtered;
          }
        }

        // Also deconflict template bindings — create explicit overrides for
        // template actions whose combos are being stolen, so the UI correctly
        // shows the combo removed from the old action.
        const template = TEMPLATES[get().activeTemplate];
        for (const [templateActionId, templateCombos] of Object.entries(template)) {
          if (templateActionId === actionId || templateActionId in overrides) continue;
          const filtered = (templateCombos as KeyCombo[]).filter((c) => !comboSet.has(c as string));
          if (filtered.length !== templateCombos.length) {
            overrides[templateActionId as ActionId] = filtered;
          }
        }

        set({ overrides, lookup: rebuild(get().activeTemplate, overrides) });
      },

      removeOverride: (actionId) => {
        const overrides = { ...get().overrides };
        delete overrides[actionId];
        set({ overrides, lookup: rebuild(get().activeTemplate, overrides) });
      },

      resetAllOverrides: () => {
        set({ overrides: {}, lookup: rebuild(get().activeTemplate, {}) });
      },
    }),
    {
      name: `${STORAGE_PREFIX}-keybindings`,
      storage: createJSONStorage(() => serverKeybindingsStorage),
      version: 1,
      partialize: (state) => ({ activeTemplate: state.activeTemplate, overrides: state.overrides }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Re-normalize persisted overrides and drop stale action IDs from old versions
        const normalized: Partial<Record<ActionId, readonly KeyCombo[]>> = {};
        for (const [actionId, combos] of Object.entries(state.overrides)) {
          if (!ACTION_IDS.has(actionId as ActionId)) continue;
          if (combos) {
            normalized[actionId as ActionId] = combos.map((c) => normalizeKeyCombo(c as string));
          }
        }
        state.overrides = normalized;
        state.lookup = rebuild(state.activeTemplate, state.overrides);
      },
    },
  ),
);
