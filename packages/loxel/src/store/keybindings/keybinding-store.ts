/**
 * Keybinding store: persists selected template and user overrides.
 * The reverse lookup map and chord prefixes are derived (not persisted) and rebuilt on changes.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { STORAGE_PREFIX } from "@/lib/env";

import { serverKeybindingsStorage } from "../server-storage";
import type { ActionId } from "./action-registry";
import { ACTION_IDS } from "./action-registry";
import type { KeyBinding } from "./key-combo";
import { bindingsOverlap, normalizeKeyBinding } from "./key-combo";
import { buildChordPrefixes, buildReverseLookup } from "./keybinding-resolver";
import type { BindingTemplate, TemplateName } from "./keybinding-schema";
import { TEMPLATES } from "./keybinding-schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BindingOverrides = Partial<Record<ActionId, readonly KeyBinding[]>>;

export interface KeybindingState {
  /** Which template profile is active. */
  activeTemplate: TemplateName;

  /** User overrides — only contains actions the user has explicitly remapped. */
  overrides: BindingOverrides;

  /** Reverse lookup: key binding -> action ID. Derived, not persisted. */
  lookup: Map<KeyBinding, ActionId>;

  /** Strict prefixes of bound chords; a pressed prefix waits for the next key. Derived. */
  chordPrefixes: Set<KeyBinding>;

  // Actions
  setTemplate: (name: TemplateName) => void;
  setOverride: (actionId: ActionId, bindings: KeyBinding[]) => void;
  removeOverride: (actionId: ActionId) => void;
  resetAllOverrides: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The state derived from a template + overrides: the reverse lookup and its chord prefixes. Every
 * writer of `activeTemplate`/`overrides` (including cross-window sync) spreads this, so derived
 * fields can't go stale.
 */
export function deriveKeybindingState(template: TemplateName, overrides: BindingOverrides) {
  const lookup = buildReverseLookup(TEMPLATES[template], overrides);
  return { lookup, chordPrefixes: buildChordPrefixes(lookup) };
}

/** Get the effective bindings for an action (template + overrides merged). */
export function getBindingsForAction(
  state: KeybindingState,
  actionId: ActionId,
): readonly KeyBinding[] {
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

/**
 * Actions (other than `actionId`) with a binding that overlaps `binding` — the same binding, or
 * one that is a chord prefix of the other.
 */
export function findOverlappingActions(
  state: KeybindingState,
  actionId: ActionId,
  binding: KeyBinding,
): ActionId[] {
  const effective = getEffectiveTemplate(state);
  return (Object.entries(effective) as [ActionId, readonly KeyBinding[]][])
    .filter(
      ([id, bindings]) => id !== actionId && bindings.some((b) => bindingsOverlap(b, binding)),
    )
    .map(([id]) => id);
}

/**
 * Set `actionId`'s override and remove overlapping bindings (equal, or chord prefixes) from every
 * other action. Template actions whose bindings are stolen get explicit overrides, so the UI shows
 * the binding removed from them.
 */
function applyOverride(
  template: BindingTemplate,
  current: BindingOverrides,
  actionId: ActionId,
  bindings: readonly KeyBinding[],
): BindingOverrides {
  const overrides: BindingOverrides = { ...current, [actionId]: bindings };
  const conflicts = (b: KeyBinding) => bindings.some((nb) => bindingsOverlap(nb, b));
  const effective = { ...template, ...overrides };
  for (const [otherId, otherBindings] of Object.entries(effective)) {
    if (otherId === actionId || !otherBindings) continue;
    const filtered = otherBindings.filter((b) => !conflicts(b));
    if (filtered.length !== otherBindings.length) overrides[otherId as ActionId] = filtered;
  }
  return overrides;
}

/**
 * Parse overrides from untrusted storage (persisted settings, other windows' sync frames): drop
 * malformed entries and action IDs from old versions, re-normalize every binding, and re-apply
 * each override so it can't overlap bindings the template gained since.
 */
export function parseBindingOverrides(template: TemplateName, raw: unknown): BindingOverrides {
  let parsed: BindingOverrides = {};
  if (typeof raw !== "object" || raw === null) return parsed;
  for (const [id, bindings] of Object.entries(raw)) {
    if (!ACTION_IDS.has(id as ActionId)) continue;
    if (!Array.isArray(bindings) || !bindings.every((b) => typeof b === "string")) continue;
    parsed = applyOverride(
      TEMPLATES[template],
      parsed,
      id as ActionId,
      bindings.map(normalizeKeyBinding),
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useKeybindingStore = create<KeybindingState>()(
  persist(
    (set, get) => ({
      activeTemplate: "loxel" as TemplateName,
      overrides: {},
      ...deriveKeybindingState("loxel", {}),

      setTemplate: (name) => {
        set({ activeTemplate: name, ...deriveKeybindingState(name, get().overrides) });
      },

      setOverride: (actionId, bindings) => {
        const template = get().activeTemplate;
        const overrides = applyOverride(TEMPLATES[template], get().overrides, actionId, bindings);
        set({ overrides, ...deriveKeybindingState(template, overrides) });
      },

      removeOverride: (actionId) => {
        const overrides = { ...get().overrides };
        delete overrides[actionId];
        set({ overrides, ...deriveKeybindingState(get().activeTemplate, overrides) });
      },

      resetAllOverrides: () => {
        set({ overrides: {}, ...deriveKeybindingState(get().activeTemplate, {}) });
      },
    }),
    {
      name: `${STORAGE_PREFIX}-keybindings`,
      storage: createJSONStorage(() => serverKeybindingsStorage),
      version: 1,
      partialize: (state) => ({ activeTemplate: state.activeTemplate, overrides: state.overrides }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const normalized = parseBindingOverrides(state.activeTemplate, state.overrides);
        // Publish through setState (not by mutating `state`) so subscribers of the derived
        // fields — e.g. the webview keystroke interception — see the loaded bindings.
        useKeybindingStore.setState({
          overrides: normalized,
          ...deriveKeybindingState(state.activeTemplate, normalized),
        });
      },
    },
  ),
);
