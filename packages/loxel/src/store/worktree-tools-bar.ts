/**
 * Per-worktree tools bar state (entries, active panels, terminals, sidebar sizes).
 * Each worktree gets its own store instance via the worktree store factory.
 */
import type { PanelId } from "./panel-config";

import {
  DEFAULT_ACTIVE_BOTTOM,
  DEFAULT_ACTIVE_LEFT,
  DEFAULT_ACTIVE_RIGHT,
  DEFAULT_TOOLBAR_ENTRIES,
  ZONE_INITIAL_SIZES,
} from "./panel-config";
import { usePanelNotificationStore } from "./panel-notifications";
import { createWorktreeStore } from "./worktree-store";
import { useWorktreeStore } from "./worktrees";

export interface SidebarSizes {
  left: number;
  bottom: number;
  right: number;
}

export interface ToolsBarEntry {
  panelId: PanelId;
}

export interface TerminalInstance {
  id: string;
  title: string;
  terminalId: string;
}

interface WorktreeToolsBarState {
  leftEntries: ToolsBarEntry[];
  bottomEntries: ToolsBarEntry[];
  rightEntries: ToolsBarEntry[];

  activeLeftPanel: PanelId | null;
  activeBottomPanel: PanelId | null;
  activeRightPanel: PanelId | null;

  /** Terminal instances tracked for PTY lifecycle (create/destroy). */
  terminals: TerminalInstance[];

  /** Last-known expanded size for each sidebar zone (for collapse/expand restoration). */
  sidebarSizes: SidebarSizes;

  addTerminal: (instance: TerminalInstance) => void;
  removeTerminal: (id: string) => void;
}

export const {
  useStore: useWorktreeToolsBar,
  getCurrent: getCurrentWorktreeToolsBar,
  purge: purgeToolsBarWorktree,
} = createWorktreeStore<WorktreeToolsBarState>((set) => ({
  ...DEFAULT_TOOLBAR_ENTRIES,

  activeLeftPanel: DEFAULT_ACTIVE_LEFT,
  activeBottomPanel: DEFAULT_ACTIVE_BOTTOM,
  activeRightPanel: DEFAULT_ACTIVE_RIGHT,

  terminals: [],

  sidebarSizes: { ...ZONE_INITIAL_SIZES },

  addTerminal: (instance) => {
    set((s) => ({ terminals: [...s.terminals, instance] }));
    const wtPath = useWorktreeStore.getState().activeWorktreePath;
    if (wtPath) {
      usePanelNotificationStore.getState().registerPanel(instance.terminalId, wtPath);
    }
  },

  removeTerminal: (id) => {
    set((s) => ({ terminals: s.terminals.filter((t) => t.id !== id) }));
  },
}));
