/**
 * Cross-tab store synchronization via WebSocket.
 *
 * When the server broadcasts a `store_updated` message (triggered by a PUT from
 * another tab), this module applies the incoming state to the local Zustand store
 * using structural sharing (reconcile) to preserve object references and avoid
 * unnecessary re-renders.
 */

import type { LogLevel } from "@/api/log-entry-model";
import { reconcile } from "@/lib/reconcile";

import { buildReverseLookup } from "./keybindings/keybinding-resolver";
import type { TemplateName } from "./keybindings/keybinding-schema";
import { TEMPLATES } from "./keybindings/keybinding-schema";
import { useKeybindingStore } from "./keybindings/keybinding-store";
import { useProjectStore } from "./projects";
import { useSearchStore } from "./search";
import { useSettingsStore } from "./settings-store";
import { useUIStore } from "./ui";
import { useWorktreeStore } from "./worktrees";

// ---------------------------------------------------------------------------
// Sync target interface
// ---------------------------------------------------------------------------

interface SyncTarget {
  /** Return the current persisted slice from the store (same shape as partialize). */
  getState: () => Record<string, unknown>;
  /** Apply reconciled state as a partial update (shallow merge). */
  setState: (partial: Record<string, unknown>) => void;
  /** Optional: convert serialized form back to native types (e.g. arrays → Sets). */
  deserialize?: (raw: Record<string, unknown>) => Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const syncTargets: Record<string, SyncTarget> = {
  settings: {
    getState: () => {
      const s = useSettingsStore.getState();
      return {
        models: s.models,
        codingAgent: s.codingAgent,
        layout: s.layout,
        terminal: s.terminal,
        editor: s.editor,
        schemas: s.schemas,
        fileAssociations: s.fileAssociations,
      };
    },
    setState: (partial) => useSettingsStore.setState(partial),
  },

  keybindings: {
    getState: () => {
      const s = useKeybindingStore.getState();
      return { activeTemplate: s.activeTemplate, overrides: s.overrides };
    },
    setState: (partial) => {
      const activeTemplate = partial.activeTemplate as TemplateName;
      const overrides = partial.overrides as Parameters<typeof buildReverseLookup>[1];
      useKeybindingStore.setState({
        activeTemplate,
        overrides,
        lookup: buildReverseLookup(TEMPLATES[activeTemplate], overrides),
      });
    },
  },

  ui: {
    getState: () => {
      const s = useUIStore.getState();
      return {
        darkMode: s.darkMode,
        diffViewMode: s.diffViewMode,
        showAllBranches: s.showAllBranches,
        diffFileTreeExpanded: s.diffFileTreeExpanded,
        favoriteBranches: s.favoriteBranches,
        logExcludedLevels: s.logExcludedLevels,
        logExcludedCategories: s.logExcludedCategories,
        logFilterSidebarOpen: s.logFilterSidebarOpen,
      };
    },
    setState: (partial) => useUIStore.setState(partial),
    deserialize: (raw) => ({
      ...raw,
      favoriteBranches: new Set((raw.favoriteBranches as string[]) ?? []),
      logExcludedLevels: new Set((raw.logExcludedLevels as LogLevel[]) ?? []),
      logExcludedCategories: new Set((raw.logExcludedCategories as string[]) ?? []),
    }),
  },

  search: {
    getState: () => {
      const s = useSearchStore.getState();
      return { recentCustomPaths: s.recentCustomPaths };
    },
    setState: (partial) => useSearchStore.setState(partial),
  },

  worktrees: {
    getState: () => {
      const s = useWorktreeStore.getState();
      // Mirror the partialize shape: only customOrder/hiddenPaths per project
      const byProject: Record<string, { customOrder?: string[]; hiddenPaths?: string[] }> = {};
      for (const [path, ps] of Object.entries(s.byProject)) {
        if (ps.customOrder || ps.hiddenPaths) {
          byProject[path] = {
            ...(ps.customOrder ? { customOrder: ps.customOrder } : {}),
            ...(ps.hiddenPaths ? { hiddenPaths: ps.hiddenPaths } : {}),
          };
        }
      }
      return { byProject };
    },
    setState: (partial) => {
      // Merge customOrder/hiddenPaths into existing byProject entries
      // without clobbering runtime worktree data (worktrees array, etc.)
      const incoming = partial.byProject as
        | Record<string, { customOrder?: string[]; hiddenPaths?: string[] }>
        | undefined;
      if (!incoming || typeof incoming !== "object") return;

      const current = useWorktreeStore.getState().byProject;
      const byProject = { ...current };
      for (const [path, saved] of Object.entries(incoming)) {
        if (!saved || typeof saved !== "object") continue;
        const existing = byProject[path] ?? { worktrees: [] };
        byProject[path] = {
          ...existing,
          ...(Array.isArray(saved.customOrder) ? { customOrder: saved.customOrder } : {}),
          ...(Array.isArray(saved.hiddenPaths) ? { hiddenPaths: saved.hiddenPaths } : {}),
        };
      }
      useWorktreeStore.setState({ byProject });
    },
  },

  projects: {
    getState: () => {
      const s = useProjectStore.getState();
      return { sidebarExpanded: s.sidebarExpanded, expandedProjectIds: s.expandedProjectIds };
    },
    setState: (partial) => useProjectStore.setState(partial),
  },
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Apply an incoming store update from another tab. Uses structural sharing
 * (reconcile) to preserve object references and skip setState when the
 * incoming state matches the current state (echo suppression).
 */
export function applyStoreUpdate(key: string, incomingState: Record<string, unknown>): void {
  const target = syncTargets[key];
  if (!target) return;

  const deserialized = target.deserialize ? target.deserialize(incomingState) : incomingState;
  const current = target.getState();
  const reconciled = reconcile(current, deserialized);

  // Same reference → incoming matches current (echo or no-op), skip setState
  if (reconciled === current) return;

  target.setState(reconciled as Record<string, unknown>);
}
