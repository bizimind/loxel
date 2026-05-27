import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { DEFAULT_SCROLLBACK_LINES, type AgentSessionOptions } from "@/api/ws-protocol";
import { STORAGE_PREFIX } from "@/lib/env";

import type { PanelId } from "./panel-config";

import { ALLOWED_ZONES, SIDEBAR_PANELS, SIDEBAR_ZONES } from "./panel-config";
import { serverSettingsStorage } from "./server-storage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SidebarPanelId = Exclude<PanelId, "diff" | "editor">;
export type SidebarZone = "left" | "bottom" | "right";

export interface ApiKeyError {
  err: string;
}

export function isApiKeyError(apiKey: string | ApiKeyError): apiKey is ApiKeyError {
  return typeof apiKey === "object" && apiKey !== null && "err" in apiKey;
}

export interface ModelEntry {
  id: string;
  label: string;
  provider: "openrouter";
  modelId: string;
  apiKey: string | ApiKeyError;
}

export type AgentFunction =
  | "planner"
  | "executor"
  | "fallback"
  | "judge"
  | "websearch"
  | "websearchFallback";

export const AGENT_FUNCTIONS: { key: AgentFunction; label: string }[] = [
  { key: "planner", label: "Planner" },
  { key: "executor", label: "Executor" },
  { key: "fallback", label: "Fallback" },
  { key: "judge", label: "Judge" },
  { key: "websearch", label: "WebSearch" },
  { key: "websearchFallback", label: "WS Fallback" },
];

export interface CodingAgentSettings {
  /** ID of the model used for all functions by default. */
  baseModelId: string;
  /** Per-function overrides. Values are ModelEntry IDs. Absent = use base model. */
  functionOverrides: Partial<Record<AgentFunction, string>>;
  /** Default session mode for new agent sessions. */
  defaultMode?: "execute" | "plan";
  /** Default tool profile for new agent sessions. */
  defaultProfile?: "execute" | "plan" | "minimal";
}

export interface NotificationSequences {
  /** OSC 9 — iTerm2 style notifications. */
  osc9: boolean;
  /** OSC 777 — rxvt-unicode style notifications. */
  osc777: boolean;
  /** OSC 99 — Kitty style notifications. */
  osc99: boolean;
}

export interface TerminalSettings {
  /** Maximum number of lines kept in terminal scrollback history. */
  scrollbackLines: number;
  /** Which OSC notification sequences to detect. */
  notificationSequences: NotificationSequences;
}

export const DEFAULT_TERMINAL_SCROLLBACK = DEFAULT_SCROLLBACK_LINES;

// ---------------------------------------------------------------------------
// Editor / Indentation
// ---------------------------------------------------------------------------

export interface IndentationDefaults {
  tabSize: number;
  insertSpaces: boolean;
}

export interface IndentationOverride {
  id: string;
  /** File extension without leading dot, e.g. "go", "py", "rs". */
  extension: string;
  tabSize: number;
  insertSpaces: boolean;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

import type { FormatterOverride, FormattingSettings } from "@/lib/formatting-model";

import { DEFAULT_FORMATTING_SETTINGS } from "@/lib/formatting-model";

export interface EditorSettings {
  indentation: IndentationDefaults;
  overrides: IndentationOverride[];
  formatting: FormattingSettings;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  indentation: { tabSize: 2, insertSpaces: true },
  overrides: [],
  formatting: structuredClone(DEFAULT_FORMATTING_SETTINGS),
};

/** Resolve indentation config for a given file path (extension match → default). */
export function resolveIndentation(editor: EditorSettings, filePath: string): IndentationDefaults {
  const lastSlash = filePath.lastIndexOf("/");
  const basename = filePath.slice(lastSlash + 1);
  if (!basename.includes(".")) return editor.indentation;
  const ext = basename.split(".").pop()!.toLowerCase();
  if (!ext) return editor.indentation;
  const override = editor.overrides.find((o) => o.extension.toLowerCase() === ext);
  if (override) return { tabSize: override.tabSize, insertSpaces: override.insertSpaces };
  return editor.indentation;
}

export const DEFAULT_NOTIFICATION_SEQUENCES: NotificationSequences = {
  osc9: true,
  osc777: true,
  osc99: true,
};

/** Per-zone default: size + which panel is active, or `false` (zone closed). */
export interface ZoneDefault {
  size: number;
  activePanel: PanelId;
}

/**
 * Layout settings define the DEFAULT initial state for new worktrees only.
 * Once a worktree is opened, its layout is persisted independently via
 * scoped stores (toolbar entries, active panels, sidebar sizes) and
 * dockview serialization (panel positions, group structure).
 */
export interface LayoutSettings {
  zoneDefaults: {
    left: ZoneDefault | false;
    bottom: ZoneDefault | false;
    right: ZoneDefault | false;
  };
  /** Ordered panel IDs per zone. Order determines toolbar icon order. */
  zonePanelOrder: Record<SidebarZone, SidebarPanelId[]>;
}

// ---------------------------------------------------------------------------
// File Associations (language override per glob)
// ---------------------------------------------------------------------------

export interface FileAssociation {
  id: string;
  /** Glob pattern, e.g. "tsconfig.json" or "tsconfig.*.json" (with leading double-star). */
  glob: string;
  /** Language ID override, e.g. "jsonc", "json", "yaml". */
  language: string;
  enabled: boolean;
}

import { EXT_TO_LANG, FILENAME_TO_LANG } from "@/lib/highlighter";

function fileAssocId(glob: string): string {
  return `builtin-fa:${glob}`;
}

function fa(glob: string, language: string): FileAssociation {
  return { id: fileAssocId(glob), glob, language, enabled: true };
}

/**
 * Built-in file association defaults. Generated from EXT_TO_LANG and
 * FILENAME_TO_LANG in highlighter.ts, plus glob-based overrides that
 * exact-filename matching can't express.
 */
export const BUILTIN_FILE_ASSOCIATIONS: FileAssociation[] = [
  // Glob-based overrides (must come first — checked before extension defaults)
  fa("**/tsconfig.json", "jsonc"),
  fa("**/tsconfig.*.json", "jsonc"),
  fa("**/jsconfig.json", "jsonc"),
  fa("**/jsconfig.*.json", "jsonc"),
  fa("**/deno.json", "jsonc"),
  fa("**/.vscode/*.json", "jsonc"),
  fa("**/*.code-workspace", "jsonc"),

  // docker-bake files — *.hcl alone maps to terraform, but bake files
  // must route to docker-language-server (dockerbake language).
  fa("**/docker-bake.hcl", "dockerbake"),
  fa("**/docker-bake.override.hcl", "dockerbake"),
  fa("**/*.docker-bake.hcl", "dockerbake"),

  // Filename-based defaults (from FILENAME_TO_LANG)
  ...Object.entries(FILENAME_TO_LANG).map(([name, lang]) => fa(`**/${name}`, lang)),

  // Extension-based defaults (from EXT_TO_LANG)
  ...Object.entries(EXT_TO_LANG).map(([ext, lang]) => fa(`**/*.${ext}`, lang)),
];

/**
 * Factory for memoized selectors that merge builtin defaults with user overrides.
 * Builtins are always present; user entries with a builtin ID only override `enabled`.
 * When `userFirst` is true, user entries appear before builtins (for precedence ordering).
 */
function createBuiltinMergeSelector<T extends { id: string; enabled: boolean }>(
  getItems: (s: SettingsState) => T[],
  builtins: readonly T[],
  builtinPrefix: string,
  userFirst?: boolean,
): (s: SettingsState) => T[] {
  let prev: T[] | undefined;
  let cached: T[] = [];
  return (s) => {
    const items = getItems(s);
    if (items === prev) return cached;
    prev = items;
    const userById = new Map(items.map((m) => [m.id, m]));
    const userEntries = items.filter((e) => !e.id.startsWith(builtinPrefix));
    const builtinEntries = builtins.map((b) => {
      const override = userById.get(b.id);
      return override ? { ...b, enabled: override.enabled } : b;
    });
    cached = userFirst ? [...userEntries, ...builtinEntries] : [...builtinEntries, ...userEntries];
    return cached;
  };
}

/** User entries first for first-match-wins precedence in resolveLanguage(). */
export const selectEffectiveFileAssociations = createBuiltinMergeSelector(
  (s) => s.fileAssociations,
  BUILTIN_FILE_ASSOCIATIONS,
  "builtin-fa:",
  true,
);

// ---------------------------------------------------------------------------
// JSON / YAML Schema Mappings
// ---------------------------------------------------------------------------

export interface SchemaMapping {
  id: string;
  glob: string;
  url: string;
  enabled: boolean;
}

/** Stable IDs for built-in schemas (derived from glob, never changes). */
function builtinId(glob: string): string {
  return `builtin:${glob}`;
}

/**
 * Built-in schema defaults. Computed at runtime, not stored.
 * User entries are additive; a stored entry with a builtin ID only overrides `enabled`.
 */
export const BUILTIN_SCHEMA_DEFAULTS: SchemaMapping[] = [
  {
    id: builtinId("**/tsconfig.json"),
    glob: "**/tsconfig.json",
    url: "https://json.schemastore.org/tsconfig",
    enabled: true,
  },
  {
    id: builtinId("**/package.json"),
    glob: "**/package.json",
    url: "https://json.schemastore.org/package",
    enabled: true,
  },
  {
    id: builtinId(".github/workflows/*.{yml,yaml}"),
    glob: ".github/workflows/*.{yml,yaml}",
    url: "https://json.schemastore.org/github-workflow",
    enabled: true,
  },
  {
    id: builtinId(".github/actions/**/*.{yml,yaml}"),
    glob: ".github/actions/**/*.{yml,yaml}",
    url: "https://json.schemastore.org/github-action",
    enabled: true,
  },
  {
    id: builtinId("**/wt.{yml,yaml}"),
    glob: "**/wt.{yml,yaml}",
    url: "__builtin:wt-json-schema__",
    enabled: true,
  },
];

export const selectEffectiveSchemas = createBuiltinMergeSelector(
  (s) => s.schemas,
  BUILTIN_SCHEMA_DEFAULTS,
  "builtin:",
);

type SettingsSection =
  | "general"
  | "codingAgent"
  | "models"
  | "keybindings"
  | "layout"
  | "terminal"
  | "editor"
  | "schemas"
  | "fileAssociations"
  | "worktrees";

export interface SettingsState {
  models: ModelEntry[];
  codingAgent: CodingAgentSettings;
  layout: LayoutSettings;
  terminal: TerminalSettings;
  editor: EditorSettings;
  /** User-added schemas + builtin overrides (disabled builtins). */
  schemas: SchemaMapping[];
  /** User file association overrides (language per glob). */
  fileAssociations: FileAssociation[];
  /** Auto-reveal active editor file in project explorer on tab switch. */
  autoRevealInExplorer: boolean;

  // Transient UI state (not persisted)
  isOpen: boolean;
  activeSection: SettingsSection;

  // Wt config editor state (transient — not persisted to localStorage)
  // Keyed by projectId so switching projects preserves unsaved edits.
  wtConfigSelectedProjectId: string | null;
  wtConfigEditorContents: Record<string, string>;
  wtConfigOriginalContents: Record<string, string>;
  wtConfigErrors: Record<string, boolean>;

  // Model actions
  addModel: (model: Omit<ModelEntry, "id">) => void;
  updateModel: (id: string, updates: Partial<Omit<ModelEntry, "id">>) => void;
  removeModel: (id: string) => void;

  // Coding agent actions
  setBaseModelId: (modelId: string) => void;
  setFunctionOverride: (fn: AgentFunction, modelId: string | null) => void;
  setDefaultMode: (mode: CodingAgentSettings["defaultMode"]) => void;
  setDefaultProfile: (profile: CodingAgentSettings["defaultProfile"]) => void;

  // Terminal actions
  updateTerminal: (partial: Partial<TerminalSettings>) => void;

  // Layout actions
  updateLayout: (partial: Partial<LayoutSettings>) => void;
  setZoneDefault: (zone: SidebarZone, value: ZoneDefault | false) => void;
  movePanel: (panelId: SidebarPanelId, targetZone: SidebarZone, insertIndex: number) => void;

  // Editor actions
  updateEditorIndentation: (partial: Partial<IndentationDefaults>) => void;
  addEditorOverride: (extension: string, tabSize: number, insertSpaces: boolean) => void;
  updateEditorOverride: (id: string, updates: Partial<Omit<IndentationOverride, "id">>) => void;
  removeEditorOverride: (id: string) => void;

  // Formatting actions
  updateFormatting: (partial: Partial<Omit<FormattingSettings, "overrides">>) => void;
  addFormatterOverride: (extensions: string, command: string, args: string) => void;
  updateFormatterOverride: (id: string, updates: Partial<Omit<FormatterOverride, "id">>) => void;
  removeFormatterOverride: (id: string) => void;

  // Schema actions
  addSchema: (glob: string, url: string) => void;
  updateSchema: (
    id: string,
    updates: Partial<Pick<SchemaMapping, "glob" | "url" | "enabled">>,
  ) => void;
  removeSchema: (id: string) => void;
  toggleSchema: (id: string) => void;

  // File association actions
  addFileAssociation: (glob: string, language: string) => void;
  updateFileAssociation: (
    id: string,
    updates: Partial<Pick<FileAssociation, "glob" | "language" | "enabled">>,
  ) => void;
  removeFileAssociation: (id: string) => void;
  toggleFileAssociation: (id: string) => void;

  // Auto-reveal
  setAutoRevealInExplorer: (enabled: boolean) => void;

  // Wt config actions
  setWtConfigSelectedProject: (projectId: string | null) => void;
  setWtConfigEditorContent: (projectId: string, content: string) => void;
  setWtConfigOriginalContent: (projectId: string, content: string) => void;
  setWtConfigHasErrors: (projectId: string, hasErrors: boolean) => void;
  resetWtConfigState: () => void;

  // UI actions
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function buildDefaultZonePanelOrder(): Record<SidebarZone, SidebarPanelId[]> {
  const order: Record<SidebarZone, SidebarPanelId[]> = { left: [], bottom: [], right: [] };
  for (const def of SIDEBAR_PANELS) {
    order[def.defaultZone].push(def.id as SidebarPanelId);
  }
  return order;
}

const DEFAULT_LAYOUT: LayoutSettings = {
  zoneDefaults: { left: false, bottom: false, right: false },
  zonePanelOrder: buildDefaultZonePanelOrder(),
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      models: [],
      codingAgent: { baseModelId: "", functionOverrides: {} },
      layout: structuredClone(DEFAULT_LAYOUT),
      terminal: {
        scrollbackLines: DEFAULT_TERMINAL_SCROLLBACK,
        notificationSequences: { ...DEFAULT_NOTIFICATION_SEQUENCES },
      },
      editor: structuredClone(DEFAULT_EDITOR_SETTINGS),
      schemas: [],
      fileAssociations: [],
      autoRevealInExplorer: false,

      isOpen: false,
      activeSection: "general",

      // Wt config editor state (transient)
      wtConfigSelectedProjectId: null,
      wtConfigEditorContents: {},
      wtConfigOriginalContents: {},
      wtConfigErrors: {},

      // -- Model CRUD --

      addModel: (model) =>
        set((s) => ({ models: [...s.models, { ...model, id: crypto.randomUUID() }] })),

      updateModel: (id, updates) =>
        set((s) => ({ models: s.models.map((m) => (m.id === id ? { ...m, ...updates } : m)) })),

      removeModel: (id) =>
        set((s) => {
          const models = s.models.filter((m) => m.id !== id);
          const codingAgent = { ...s.codingAgent };

          // Clear dangling references
          if (codingAgent.baseModelId === id) {
            codingAgent.baseModelId = "";
          }
          const overrides = { ...codingAgent.functionOverrides };
          for (const [fn, modelId] of Object.entries(overrides)) {
            if (modelId === id) delete overrides[fn as AgentFunction];
          }
          codingAgent.functionOverrides = overrides;

          return { models, codingAgent };
        }),

      // -- Coding agent --

      setBaseModelId: (modelId) =>
        set((s) => ({ codingAgent: { ...s.codingAgent, baseModelId: modelId } })),

      setFunctionOverride: (fn, modelId) =>
        set((s) => {
          const overrides = { ...s.codingAgent.functionOverrides };
          if (modelId) {
            overrides[fn] = modelId;
          } else {
            delete overrides[fn];
          }
          return { codingAgent: { ...s.codingAgent, functionOverrides: overrides } };
        }),

      setDefaultMode: (mode) =>
        set((s) => ({ codingAgent: { ...s.codingAgent, defaultMode: mode } })),

      setDefaultProfile: (profile) =>
        set((s) => ({ codingAgent: { ...s.codingAgent, defaultProfile: profile } })),

      // -- Terminal --

      updateTerminal: (partial) => set((s) => ({ terminal: { ...s.terminal, ...partial } })),

      // -- Layout --

      updateLayout: (partial) => set((s) => ({ layout: { ...s.layout, ...partial } })),

      setZoneDefault: (zone, value) =>
        set((s) => ({
          layout: { ...s.layout, zoneDefaults: { ...s.layout.zoneDefaults, [zone]: value } },
        })),

      movePanel: (panelId, targetZone, insertIndex) =>
        set((s) => {
          const allowed = ALLOWED_ZONES[panelId as PanelId];
          if (allowed && !allowed.includes(targetZone)) return {};

          const zonePanelOrder = structuredClone(s.layout.zonePanelOrder);

          for (const zone of SIDEBAR_ZONES) {
            const idx = zonePanelOrder[zone].indexOf(panelId);
            if (idx !== -1) {
              zonePanelOrder[zone].splice(idx, 1);
              break;
            }
          }

          const clamped = Math.min(insertIndex, zonePanelOrder[targetZone].length);
          zonePanelOrder[targetZone].splice(clamped, 0, panelId);

          // Keep activePanel in sync with the first panel in each zone.
          // The UI shows "Default" on index 0 and the description says
          // "the top panel in each zone opens by default".
          const zoneDefaults = { ...s.layout.zoneDefaults };
          for (const z of SIDEBAR_ZONES) {
            const zd = zoneDefaults[z];
            if (!zd) continue;
            const first = zonePanelOrder[z][0];
            if (!first) {
              zoneDefaults[z] = false;
            } else if (zd.activePanel !== first) {
              zoneDefaults[z] = { ...zd, activePanel: first };
            }
          }
          return { layout: { ...s.layout, zonePanelOrder, zoneDefaults } };
        }),

      // -- Editor --

      updateEditorIndentation: (partial) =>
        set((s) => ({
          editor: { ...s.editor, indentation: { ...s.editor.indentation, ...partial } },
        })),

      addEditorOverride: (extension, tabSize, insertSpaces) =>
        set((s) => {
          const normalized = extension.toLowerCase().replace(/^\./, "");
          if (
            normalized &&
            s.editor.overrides.some((o) => o.extension.toLowerCase() === normalized)
          )
            return {};
          return {
            editor: {
              ...s.editor,
              overrides: [
                ...s.editor.overrides,
                { id: crypto.randomUUID(), extension: normalized, tabSize, insertSpaces },
              ],
            },
          };
        }),

      updateEditorOverride: (id, updates) =>
        set((s) => ({
          editor: {
            ...s.editor,
            overrides: s.editor.overrides.map((o) => (o.id === id ? { ...o, ...updates } : o)),
          },
        })),

      removeEditorOverride: (id) =>
        set((s) => ({
          editor: { ...s.editor, overrides: s.editor.overrides.filter((o) => o.id !== id) },
        })),

      // -- Formatting --

      updateFormatting: (partial) =>
        set((s) => ({
          editor: { ...s.editor, formatting: { ...s.editor.formatting, ...partial } },
        })),

      addFormatterOverride: (extensions, command, args) =>
        set((s) => ({
          editor: {
            ...s.editor,
            formatting: {
              ...s.editor.formatting,
              overrides: [
                ...s.editor.formatting.overrides,
                { id: crypto.randomUUID(), extensions, command, args },
              ],
            },
          },
        })),

      updateFormatterOverride: (id, updates) =>
        set((s) => ({
          editor: {
            ...s.editor,
            formatting: {
              ...s.editor.formatting,
              overrides: s.editor.formatting.overrides.map((o) =>
                o.id === id ? { ...o, ...updates } : o,
              ),
            },
          },
        })),

      removeFormatterOverride: (id) =>
        set((s) => ({
          editor: {
            ...s.editor,
            formatting: {
              ...s.editor.formatting,
              overrides: s.editor.formatting.overrides.filter((o) => o.id !== id),
            },
          },
        })),

      // -- Schemas --

      addSchema: (glob, url) =>
        set((s) => ({
          schemas: [...s.schemas, { id: crypto.randomUUID(), glob, url, enabled: true }],
        })),

      updateSchema: (id, updates) =>
        set((s) => ({ schemas: s.schemas.map((m) => (m.id === id ? { ...m, ...updates } : m)) })),

      removeSchema: (id) => set((s) => ({ schemas: s.schemas.filter((m) => m.id !== id) })),

      toggleSchema: (id) =>
        set((s) => {
          const existing = s.schemas.find((m) => m.id === id);
          if (existing) {
            // Toggle existing entry
            return {
              schemas: s.schemas.map((m) => (m.id === id ? { ...m, enabled: !m.enabled } : m)),
            };
          }
          // Toggling a builtin that has no stored override — store a disabled override
          const builtin = BUILTIN_SCHEMA_DEFAULTS.find((b) => b.id === id);
          if (builtin) {
            return { schemas: [...s.schemas, { ...builtin, enabled: !builtin.enabled }] };
          }
          return {};
        }),

      // -- File associations --

      addFileAssociation: (glob, language) =>
        set((s) => ({
          fileAssociations: [
            ...s.fileAssociations,
            { id: crypto.randomUUID(), glob, language, enabled: true },
          ],
        })),

      updateFileAssociation: (id, updates) =>
        set((s) => ({
          fileAssociations: s.fileAssociations.map((m) => (m.id === id ? { ...m, ...updates } : m)),
        })),

      removeFileAssociation: (id) =>
        set((s) => ({ fileAssociations: s.fileAssociations.filter((m) => m.id !== id) })),

      toggleFileAssociation: (id) =>
        set((s) => {
          const existing = s.fileAssociations.find((m) => m.id === id);
          if (existing) {
            return {
              fileAssociations: s.fileAssociations.map((m) =>
                m.id === id ? { ...m, enabled: !m.enabled } : m,
              ),
            };
          }
          const builtin = BUILTIN_FILE_ASSOCIATIONS.find((b) => b.id === id);
          if (builtin) {
            return {
              fileAssociations: [...s.fileAssociations, { ...builtin, enabled: !builtin.enabled }],
            };
          }
          return {};
        }),

      // -- Auto-reveal --

      setAutoRevealInExplorer: (enabled) => set({ autoRevealInExplorer: enabled }),

      // -- Wt config --

      setWtConfigSelectedProject: (projectId) => set({ wtConfigSelectedProjectId: projectId }),
      setWtConfigEditorContent: (projectId, content) =>
        set((s) => ({
          wtConfigEditorContents: { ...s.wtConfigEditorContents, [projectId]: content },
        })),
      setWtConfigOriginalContent: (projectId, content) =>
        set((s) => ({
          wtConfigOriginalContents: { ...s.wtConfigOriginalContents, [projectId]: content },
        })),
      setWtConfigHasErrors: (projectId, hasErrors) =>
        set((s) => ({ wtConfigErrors: { ...s.wtConfigErrors, [projectId]: hasErrors } })),
      resetWtConfigState: () =>
        set({
          wtConfigSelectedProjectId: null,
          wtConfigEditorContents: {},
          wtConfigOriginalContents: {},
          wtConfigErrors: {},
        }),

      // -- UI --

      openSettings: (section) => set({ isOpen: true, ...(section && { activeSection: section }) }),
      closeSettings: () => set({ isOpen: false }),
    }),
    {
      name: `${STORAGE_PREFIX}-settings`,
      storage: createJSONStorage(() => serverSettingsStorage),
      partialize: (state) => ({
        models: state.models,
        codingAgent: state.codingAgent,
        layout: state.layout,
        terminal: state.terminal,
        editor: state.editor,
        schemas: state.schemas,
        fileAssociations: state.fileAssociations,
        autoRevealInExplorer: state.autoRevealInExplorer,
      }),
      version: 10,
      migrate: (persisted, version) => {
        if (typeof persisted !== "object" || persisted === null) return persisted as SettingsState;
        const state = persisted as Record<string, unknown>;

        if (version === 0) {
          // v0 → v1: panelDefaultZones → zonePanelOrder
          const layout =
            typeof state.layout === "object" && state.layout !== null
              ? (state.layout as Record<string, unknown>)
              : undefined;
          if (layout && typeof layout.panelDefaultZones === "object" && layout.panelDefaultZones) {
            const map = layout.panelDefaultZones as Record<SidebarPanelId, SidebarZone>;
            const order: Record<SidebarZone, SidebarPanelId[]> = {
              left: [],
              bottom: [],
              right: [],
            };
            for (const def of SIDEBAR_PANELS) {
              const zone = map[def.id as SidebarPanelId] ?? def.defaultZone;
              order[zone].push(def.id as SidebarPanelId);
            }
            layout.zonePanelOrder = order;
            delete layout.panelDefaultZones;
          }
        }

        if (version <= 1) {
          // v1 → v2: flat CodingAgentSettings → models library + baseModelId + overrides
          const oldAgent =
            typeof state.codingAgent === "object" && state.codingAgent !== null
              ? (state.codingAgent as Record<string, string>)
              : undefined;
          const models: ModelEntry[] = [];

          const apiKey = oldAgent?.openrouterApiKey ?? "";
          if (apiKey) {
            let baseModelId: string;
            const modelFields = [
              oldAgent?.plannerModel,
              oldAgent?.executorModel,
              oldAgent?.fallbackModel,
              oldAgent?.judgeModel,
              oldAgent?.websearchModel,
              oldAgent?.websearchFallbackModel,
            ].filter((v): v is string => Boolean(v));
            const uniqueModelIds = [...new Set(modelFields)];

            for (const modelId of uniqueModelIds) {
              models.push({
                id: crypto.randomUUID(),
                label: modelId,
                provider: "openrouter",
                modelId,
                apiKey,
              });
            }

            const baseModelModelId = oldAgent?.plannerModel || uniqueModelIds[0] || "";
            const baseEntry = models.find((m) => m.modelId === baseModelModelId);
            baseModelId = baseEntry?.id ?? "";

            const functionOverrides: Partial<Record<AgentFunction, string>> = {};
            const fnMapping: [AgentFunction, string][] = [
              ["planner", oldAgent?.plannerModel || ""],
              ["executor", oldAgent?.executorModel || ""],
              ["fallback", oldAgent?.fallbackModel || ""],
              ["judge", oldAgent?.judgeModel || ""],
              ["websearch", oldAgent?.websearchModel || ""],
              ["websearchFallback", oldAgent?.websearchFallbackModel || ""],
            ];
            for (const [fn, mId] of fnMapping) {
              if (mId && mId !== baseModelModelId) {
                const entry = models.find((m) => m.modelId === mId);
                if (entry) functionOverrides[fn] = entry.id;
              }
            }

            state.codingAgent = { baseModelId, functionOverrides };
          } else {
            state.codingAgent = { baseModelId: "", functionOverrides: {} };
          }
          state.models = models;
        }

        if (version <= 2) {
          // v2 → v3: "terminal" sidebar panel was removed — strip from zonePanelOrder
          const layout =
            typeof state.layout === "object" && state.layout !== null
              ? (state.layout as Record<string, unknown>)
              : undefined;
          if (layout && typeof layout.zonePanelOrder === "object" && layout.zonePanelOrder) {
            const order = layout.zonePanelOrder as Record<string, string[]>;
            for (const zone of ["left", "bottom", "right"]) {
              if (Array.isArray(order[zone])) {
                order[zone] = order[zone].filter((id: string) => id !== "terminal");
              }
            }
          }
        }

        if (version <= 3) {
          // v3 → v4: add terminal settings with default scrollback
          if (!state.terminal) {
            state.terminal = { scrollbackLines: DEFAULT_TERMINAL_SCROLLBACK };
          }
        }

        if (version <= 4) {
          // v4 → v5: add notification sequences to terminal settings
          const terminal =
            typeof state.terminal === "object" && state.terminal !== null
              ? (state.terminal as Record<string, unknown>)
              : undefined;
          if (terminal && !terminal.notificationSequences) {
            terminal.notificationSequences = { ...DEFAULT_NOTIFICATION_SEQUENCES };
          }
        }

        if (version <= 5) {
          // v5 → v6: add schemas array
          if (!Array.isArray(state.schemas)) {
            state.schemas = [];
          }
        }

        if (version <= 6) {
          // v6 → v7: add editor indentation settings
          if (!state.editor) {
            state.editor = structuredClone(DEFAULT_EDITOR_SETTINGS);
          }
        }

        if (version <= 7) {
          // v7 → v8: add formatting settings to editor
          const editor =
            typeof state.editor === "object" && state.editor !== null
              ? (state.editor as Record<string, unknown>)
              : undefined;
          if (editor && !editor.formatting) {
            editor.formatting = structuredClone(DEFAULT_FORMATTING_SETTINGS);
          }
        }

        if (version <= 8) {
          // v8 → v9: add file associations array
          if (!Array.isArray(state.fileAssociations)) {
            state.fileAssociations = [];
          }
        }

        if (version <= 9) {
          // v9 → v10: add auto-reveal in explorer setting
          if (state.autoRevealInExplorer === undefined) {
            state.autoRevealInExplorer = false;
          }
        }

        // zustand migrations receive unknown and must return the store type.
        // Structural guards above ensure each field is valid before narrowing.
        return state as unknown as SettingsState;
      },
    },
  ),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map AgentFunction keys to ModelRouterOptions property names (casing differs for webSearch). */
const ROUTER_KEY_MAP: Record<AgentFunction, string> = {
  planner: "planner",
  executor: "executor",
  fallback: "fallback",
  judge: "judge",
  websearch: "webSearch",
  websearchFallback: "webSearchFallback",
};

/** Resolve model library + agent config into typed SDK session options. */
export function buildSessionOptions(
  settings: CodingAgentSettings,
  models: ModelEntry[],
): AgentSessionOptions | Record<string, never> {
  const lookup = new Map(models.map((m) => [m.id, m]));
  const baseEntry = lookup.get(settings.baseModelId);
  if (!baseEntry || isApiKeyError(baseEntry.apiKey)) return {};

  const base = { modelId: baseEntry.modelId, apiKey: baseEntry.apiKey };
  const modelConfig: Record<string, { modelId: string; apiKey: string }> = { base };

  for (const [fn, routerKey] of Object.entries(ROUTER_KEY_MAP)) {
    const overrideId = settings.functionOverrides[fn as AgentFunction];
    const entry = overrideId ? lookup.get(overrideId) : undefined;
    if (entry && !isApiKeyError(entry.apiKey)) {
      modelConfig[routerKey] = { modelId: entry.modelId, apiKey: entry.apiKey };
    }
  }

  const result: AgentSessionOptions = { models: modelConfig };
  if (settings.defaultMode) result.mode = settings.defaultMode;
  if (settings.defaultProfile) result.profile = settings.defaultProfile;
  return result;
}

/** Resolved layout config for use by createDefaultLayout. */
export interface EffectiveLayoutConfig {
  zoneDefaults: {
    left: ZoneDefault | false;
    bottom: ZoneDefault | false;
    right: ZoneDefault | false;
  };
  zonePanelOrder: Record<SidebarZone, SidebarPanelId[]>;
}

export function getEffectiveLayoutConfig(): EffectiveLayoutConfig {
  const { layout } = useSettingsStore.getState();
  const { zonePanelOrder } = layout;

  const zoneDefaults = { ...layout.zoneDefaults };
  for (const zone of SIDEBAR_ZONES) {
    const zd = zoneDefaults[zone];
    if (!zd) continue;
    const zonePanels = zonePanelOrder[zone];
    if (!zonePanels.includes(zd.activePanel as SidebarPanelId)) {
      zoneDefaults[zone] = zonePanels[0] ? { ...zd, activePanel: zonePanels[0] } : false;
    }
  }

  return { zoneDefaults, zonePanelOrder };
}

/** Whether any wt.yaml editor has been modified from its original content. */
export function selectIsWtConfigDirty(s: SettingsState): boolean {
  for (const [pid, content] of Object.entries(s.wtConfigEditorContents)) {
    if (content !== s.wtConfigOriginalContents[pid]) return true;
  }
  return false;
}

/** Whether any dirty wt config has validation errors. */
export function selectWtConfigHasAnyErrors(s: SettingsState): boolean {
  for (const [pid, content] of Object.entries(s.wtConfigEditorContents)) {
    if (content !== s.wtConfigOriginalContents[pid] && s.wtConfigErrors[pid]) return true;
  }
  return false;
}

/** Return all dirty wt configs that are error-free and ready to save. */
export function getDirtyWtConfigs(s: SettingsState): { projectId: string; content: string }[] {
  const result: { projectId: string; content: string }[] = [];
  for (const [pid, content] of Object.entries(s.wtConfigEditorContents)) {
    if (content !== s.wtConfigOriginalContents[pid] && !s.wtConfigErrors[pid]) {
      result.push({ projectId: pid, content });
    }
  }
  return result;
}

/** Build toolbar entries from a zonePanelOrder config. Single source for this derivation. */
export function buildToolbarEntries(zonePanelOrder: Record<SidebarZone, SidebarPanelId[]>) {
  return {
    leftEntries: zonePanelOrder.left.map((panelId) => ({ panelId })),
    bottomEntries: zonePanelOrder.bottom.map((panelId) => ({ panelId })),
    rightEntries: zonePanelOrder.right.map((panelId) => ({ panelId })),
  };
}

export { ZONE_INITIAL_SIZES as ZONE_FALLBACK_SIZES } from "./panel-config";
