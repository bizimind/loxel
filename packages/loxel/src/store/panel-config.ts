import type { LucideIcon } from "lucide-react";
import {
  BotIcon,
  BugPlayIcon,
  DatabaseIcon,
  FileDiffIcon,
  FileTextIcon,
  FolderTreeIcon,
  GitBranchIcon,
  GitForkIcon,
  GlobeIcon,
  ImageIcon,
  MessageSquareIcon,
  PencilRulerIcon,
  ScrollTextIcon,
  SquareTerminalIcon,
} from "lucide-react";

import type { ActionId } from "./keybindings/action-registry";

export type PanelZone = "left" | "bottom" | "right" | "center";

/**
 * All panel IDs. Sidebar panels are described in SIDEBAR_PANELS below.
 * Center-only IDs (diff, editor) exist for backward compatibility with
 * persisted dockview layouts and the ALLOWED_ZONES map.
 */
export type PanelId =
  | "changes"
  | "projectFiles"
  | "git"
  | "diff"
  | "editor"
  | "comments"
  | "logs"
  | "forkTree";

export interface SidebarPanelDef {
  id: PanelId;
  label: string;
  icon: LucideIcon;
  /** The zone this panel starts in by default. */
  defaultZone: "left" | "bottom" | "right";
  /** All zones this panel is allowed in (for drag constraints). */
  allowedZones: readonly PanelZone[];
  /** Whether this panel is the default-active panel for its zone on fresh load. */
  defaultActive: boolean;
  /** Title used in dockview tab. Falls back to `label` if not set. */
  dockviewTitle?: string;
}

/**
 * Single source of truth for all sidebar panel configuration.
 * Order within each zone determines toolbar icon order and layout creation order.
 *
 * Sidebar groups never split — all panels in a zone share one tabbed group.
 * This is enforced by onWillShowOverlay in App.tsx, not per-panel config.
 *
 * To add/remove/reconfigure a sidebar panel: edit this array.
 * To change which panels are open by default: toggle `defaultActive`.
 */
export const SIDEBAR_PANELS: readonly SidebarPanelDef[] = [
  {
    id: "projectFiles",
    label: "Project Files",
    icon: FolderTreeIcon,
    defaultZone: "left",
    allowedZones: ["left", "bottom", "right"],
    defaultActive: false,
    dockviewTitle: "Files",
  },
  {
    id: "changes",
    label: "Changes",
    icon: FileDiffIcon,
    defaultZone: "left",
    allowedZones: ["left", "bottom", "right"],
    defaultActive: false,
  },
  {
    id: "git",
    label: "Git",
    icon: GitBranchIcon,
    defaultZone: "bottom",
    allowedZones: ["left", "bottom", "right"],
    defaultActive: false,
  },
  {
    id: "comments",
    label: "Comments",
    icon: MessageSquareIcon,
    defaultZone: "right",
    allowedZones: ["left", "bottom", "right"],
    defaultActive: false,
  },
  {
    id: "logs",
    label: "Logs",
    icon: ScrollTextIcon,
    defaultZone: "bottom",
    allowedZones: ["left", "bottom", "right"],
    defaultActive: false,
  },
  {
    id: "forkTree",
    label: "Fork Tree",
    icon: GitForkIcon,
    defaultZone: "right",
    allowedZones: ["left", "right"],
    defaultActive: false,
    dockviewTitle: "Forks",
  },
];

// ---------------------------------------------------------------------------
// Center panel registry
// ---------------------------------------------------------------------------

export interface CenterPanelDef {
  /** Unique type key for this panel kind. */
  readonly type: string;
  /** ID prefix for multi-instance panels, or exact ID for singletons. */
  readonly idPrefix: string;
  /** Dockview `component` key (maps to `components` registry in panels.tsx). */
  readonly component: string;
  /** Dockview `tabComponent` key (maps to `tabComponents` registry in panels.tsx). */
  readonly tabComponent: string;
  /** Lucide icon used in tabs and quickstart. */
  readonly icon: LucideIcon;
  /** Label shown in CenterPlaceholder quickstart. Null = not shown. */
  readonly quickstartLabel: string | null;
  /** ActionId for the "new panel" keybinding. Null if not creatable via keybinding. */
  readonly actionId: ActionId | null;
  /** Custom event name for creation. */
  readonly createEvent: string;
  /** Custom event name for opening an existing file. Null if not applicable. */
  readonly openEvent: string | null;
  /** Default title prefix for nextPanelTitle(). */
  readonly titlePrefix: string;
  /** Panel kind — describes the panel's runtime behavior. */
  readonly kind: "connected-process" | "file-editor" | "state-view";
  /** Whether only one instance of this panel type can exist. */
  readonly singleton: boolean;
}

/**
 * Single source of truth for all center panel configuration.
 *
 * To add a new center panel type: add an entry here, then register its
 * React component in panels.tsx `components` and its tab in `tabComponents`.
 * Everything else (isCenterPanel, quickstart, keybinding dispatch, split logic)
 * is derived automatically from this registry.
 */
export const CENTER_PANELS = [
  // Order determines quickstart menu order (entries with quickstartLabel).
  // Original quickstart order: Agent, Plan, Terminal, Drawing, Browser.
  {
    type: "agent",
    idPrefix: "agent-",
    component: "codingAgent",
    tabComponent: "codingAgentTab",
    icon: BotIcon,
    quickstartLabel: "New Agent",
    actionId: "panel.new.agent" as const,
    createEvent: "loxel-create-agent",
    openEvent: null,
    titlePrefix: "Agent",
    kind: "connected-process" as const,
    singleton: false,
  },
  {
    type: "agentDevTools",
    idPrefix: "agentdevtools-",
    component: "agentDevTools",
    tabComponent: "agentDevToolsTab",
    icon: BugPlayIcon,
    quickstartLabel: null,
    actionId: null,
    createEvent: "loxel-open-agent-devtools",
    openEvent: "loxel-open-agent-devtools",
    titlePrefix: "DevTools",
    kind: "state-view" as const,
    singleton: false,
  },
  {
    type: "editor",
    idPrefix: "editor-",
    component: "editor",
    tabComponent: "markdownEditorTab",
    icon: FileTextIcon,
    quickstartLabel: "New Plan",
    actionId: "panel.new.markdown" as const,
    createEvent: "loxel-create-editor",
    openEvent: "loxel-open-markdown-editor",
    titlePrefix: "Note",
    kind: "file-editor" as const,
    singleton: false,
  },
  {
    type: "terminal",
    idPrefix: "terminal-",
    component: "terminal",
    tabComponent: "terminalTab",
    icon: SquareTerminalIcon,
    quickstartLabel: "New Terminal",
    actionId: "panel.new.terminal" as const,
    createEvent: "loxel-create-terminal",
    openEvent: null,
    titlePrefix: "Terminal",
    kind: "connected-process" as const,
    singleton: false,
  },
  {
    type: "excalidraw",
    idPrefix: "drawing-",
    component: "excalidraw",
    tabComponent: "excalidrawEditorTab",
    icon: PencilRulerIcon,
    quickstartLabel: "New Drawing",
    actionId: "panel.new.drawing" as const,
    createEvent: "loxel-create-drawing",
    openEvent: "loxel-open-drawing-editor",
    titlePrefix: "Drawing",
    kind: "file-editor" as const,
    singleton: false,
  },
  {
    type: "browser",
    idPrefix: "browser-",
    component: "browser",
    tabComponent: "browserTab",
    icon: GlobeIcon,
    quickstartLabel: "New Browser",
    actionId: "panel.new.browser" as const,
    createEvent: "loxel-create-browser",
    openEvent: null,
    titlePrefix: "Browser",
    kind: "state-view" as const,
    singleton: false,
  },
  // Non-quickstart panels (no quickstartLabel)
  {
    type: "media",
    idPrefix: "media-",
    component: "media",
    tabComponent: "mediaTab",
    icon: ImageIcon,
    quickstartLabel: null,
    actionId: null,
    createEvent: "loxel-create-media",
    openEvent: "loxel-open-media-viewer",
    titlePrefix: "Media",
    kind: "state-view" as const,
    singleton: false,
  },
  {
    type: "codeEditor",
    idPrefix: "codeeditor-",
    component: "codeEditor",
    tabComponent: "codeEditorTab",
    icon: FileTextIcon,
    quickstartLabel: null,
    actionId: null,
    createEvent: "loxel-create-code-editor",
    openEvent: "loxel-open-code-editor",
    titlePrefix: "Untitled",
    kind: "file-editor" as const,
    singleton: false,
  },
  {
    type: "diff",
    idPrefix: "diff",
    component: "diff",
    tabComponent: "diffTab",
    icon: FileDiffIcon,
    quickstartLabel: null,
    actionId: null,
    createEvent: "loxel-open-diff",
    openEvent: "loxel-open-diff",
    titlePrefix: "Diff",
    kind: "state-view" as const,
    singleton: true,
  },
  {
    type: "localDb",
    idPrefix: "localdb-",
    component: "localDb",
    tabComponent: "localDbTab",
    icon: DatabaseIcon,
    quickstartLabel: "Database",
    actionId: "panel.open.localdb" as const,
    createEvent: "loxel-open-localdb",
    openEvent: "loxel-open-localdb",
    titlePrefix: "Database",
    kind: "state-view" as const,
    singleton: true,
  },
] as const satisfies readonly CenterPanelDef[];

/** Derived type: center panel type key. */
export type CenterPanelType = (typeof CENTER_PANELS)[number]["type"];

// --- Derived lookups from CENTER_PANELS ---

const centerPanelByType = new Map<string, CenterPanelDef>(
  CENTER_PANELS.map((def) => [def.type, def]),
);

/** Look up a center panel def by its type key. */
export function getCenterPanelDefByType(type: string): CenterPanelDef | undefined {
  return centerPanelByType.get(type);
}

/** Look up a center panel def by matching its ID prefix against a panel ID. */
export function getCenterPanelDef(panelId: string): CenterPanelDef | undefined {
  for (const def of CENTER_PANELS) {
    if (def.singleton ? panelId === def.idPrefix : panelId.startsWith(def.idPrefix)) {
      return def;
    }
  }
  return undefined;
}

/** All quickstart-visible panels (for CenterPlaceholder). */
export const QUICKSTART_PANELS = CENTER_PANELS.filter(
  (def): def is typeof def & { quickstartLabel: string } => def.quickstartLabel !== null,
);

/** Map from actionId → createEvent for panel creation keybindings. */
const actionToCreateEvent = new Map<string, string>(
  CENTER_PANELS.filter((d) => d.actionId !== null).map((d) => [d.actionId!, d.createEvent]),
);

/** Get the custom event name for a panel creation action ID. */
export function getCreateEventForAction(actionId: string): string | undefined {
  return actionToCreateEvent.get(actionId);
}

// ---------------------------------------------------------------------------
// Sidebar derived lookups
// ---------------------------------------------------------------------------

function panelsInZone(zone: "left" | "bottom" | "right"): SidebarPanelDef[] {
  return SIDEBAR_PANELS.filter((def) => def.defaultZone === zone);
}

const panelDefMap = new Map<PanelId, SidebarPanelDef>(SIDEBAR_PANELS.map((def) => [def.id, def]));

/** Which zones each PanelId is allowed in. Includes center-only panels. */
function buildAllowedZones(): Record<PanelId, readonly PanelZone[]> {
  const zones: Partial<Record<PanelId, readonly PanelZone[]>> = {
    diff: ["center"],
    editor: ["center"],
  };
  for (const def of SIDEBAR_PANELS) {
    zones[def.id] = def.allowedZones;
  }
  return zones as Record<PanelId, readonly PanelZone[]>;
}

export const ALLOWED_ZONES: Record<PanelId, readonly PanelZone[]> = buildAllowedZones();

/** Default toolbar entries per zone, derived from SIDEBAR_PANELS defaultZone. */
export const DEFAULT_TOOLBAR_ENTRIES = {
  leftEntries: panelsInZone("left").map((def) => ({ panelId: def.id })),
  bottomEntries: panelsInZone("bottom").map((def) => ({ panelId: def.id })),
  rightEntries: panelsInZone("right").map((def) => ({ panelId: def.id })),
};

/** Default active panel per zone (first `defaultActive: true` panel, or null). */
export const DEFAULT_ACTIVE_LEFT: PanelId | null =
  panelsInZone("left").find((def) => def.defaultActive)?.id ?? null;

export const DEFAULT_ACTIVE_BOTTOM: PanelId | null =
  panelsInZone("bottom").find((def) => def.defaultActive)?.id ?? null;

export const DEFAULT_ACTIVE_RIGHT: PanelId | null =
  panelsInZone("right").find((def) => def.defaultActive)?.id ?? null;

/** All sidebar zones. Use this instead of inline `["left", "bottom", "right"] as const`. */
export const SIDEBAR_ZONES: readonly ("left" | "bottom" | "right")[] = ["left", "bottom", "right"];

/** Maps sidebar zone → dockview direction for positioning relative to center. */
export const ZONE_DIRECTION_MAP = { left: "left", bottom: "below", right: "right" } as const;

/** Initial size for each zone (width for left/right, height for bottom). */
export const ZONE_INITIAL_SIZES = { left: 250, bottom: 300, right: 320 } as const;

/** Icon for a sidebar panel (returns undefined for center-only panels). */
export function getPanelIcon(panelId: PanelId): LucideIcon | undefined {
  return panelDefMap.get(panelId)?.icon;
}

/** Label for a sidebar panel (returns undefined for center-only panels). */
export function getPanelLabel(panelId: PanelId): string | undefined {
  return panelDefMap.get(panelId)?.label;
}

/** Whether a panel ID belongs in the center zone. Derived from CENTER_PANELS. */
export function isCenterPanel(panelId: string): boolean {
  return CENTER_PANELS.some((def) =>
    def.singleton ? panelId === def.idPrefix : panelId.startsWith(def.idPrefix),
  );
}

/** Dockview title for a sidebar panel. Falls back to label, then panelId. */
export function getPanelTitle(panelId: PanelId): string {
  const def = panelDefMap.get(panelId);
  return def?.dockviewTitle ?? def?.label ?? panelId;
}
