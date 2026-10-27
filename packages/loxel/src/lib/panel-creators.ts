/**
 * Imperative panel creation and lifecycle functions.
 *
 * These operate on the center dockview API via getCenterApi() and read from
 * Zustand stores directly. They are module-level (not React hooks) because
 * they must run outside the React render cycle (event handlers, store actions).
 */
import type {
  AddPanelOptions,
  AddPanelPositionOptions,
  DockviewApi,
  IDockviewPanel,
  PanelOptions,
} from "dockview-react";

import * as api from "@/api/client";
import type {
  PanelOpenOptions,
  PanelPlacement,
  PlacementTab,
  SplitDirection,
} from "@/api/panel-placement-model";
import { nextPanelTitle } from "@/components/dockview/default-layout";
import { getPanelWorktreePath } from "@/components/dockview/panel-context";
import { renameEditorCacheKey, setEditorContent } from "@/components/editor/MarkdownEditor";
import { renameDrawingCacheKey } from "@/components/excalidraw-editor/ExcalidrawEditor";
import { showToast } from "@/components/ui/toast";
import { getDisplayFilename } from "@/lib/detached-path";
import { frontendLog } from "@/lib/frontend-logger";
import { filePanelType } from "@/lib/open-file";
import type { FilePanelType } from "@/lib/open-file";
import { isWithin } from "@/lib/project-file-helpers";
import { saveEditorContent } from "@/lib/save-editor-content";
import { threeWayMerge } from "@/lib/three-way-merge";
import { queryKeys } from "@/queries/query-keys";
import { getQueryScope } from "@/queries/use-scope";
import { queryClient } from "@/query-client";
import { useEditorStateStore } from "@/store/editor-state";
import { activatePanel, reattachActiveContent } from "@/store/layout-actions";
import { getCenterPanelDefByType } from "@/store/panel-config";
import { getCenterApi } from "@/store/tools-bar";
import { getCurrentWorktreeToolsBar } from "@/store/worktree-tools-bar";
import { useWorktreeStore } from "@/store/worktrees";

const uiLog = frontendLog.child("ui");
const filesLog = frontendLog.child("files");

function invalidateDetachedFiles(): void {
  const { activeProjectPath, activeWorktreePath } = getQueryScope();
  queryClient.invalidateQueries({
    queryKey: queryKeys.detachedFiles(activeProjectPath, activeWorktreePath),
  });
}

// -- Concurrency guards (module-level, not useRef — these run outside React) --

let creatingEditor = false;
let creatingDrawing = false;
let creatingCodeEditor = false;

// -- Placement --

/** `addPanel` direction for each split direction. */
const ADD_DIRECTION = {
  right: "right",
  left: "left",
  up: "above",
  down: "below",
} as const satisfies Record<SplitDirection, string>;

/** `moveTo` position for each split direction. */
const MOVE_POSITION = {
  right: "right",
  left: "left",
  up: "top",
  down: "bottom",
} as const satisfies Record<SplitDirection, string>;

/**
 * The open tab a {@link PlacementTab} names: the one showing its file, else one with its title.
 * Among several tabs with that title, the active tab wins, then one visible in its group.
 */
function findPlacementTab(api: DockviewApi, tab: PlacementTab): IDockviewPanel | undefined {
  const byPath = tab.path ? api.panels.find((p) => getPanelFilePath(p.params) === tab.path) : null;
  if (byPath) return byPath;
  const titled = api.panels.filter((p) => p.title === tab.name);
  return (
    titled.find((p) => p === api.activePanel) ??
    titled.find((p) => p.group.activePanel === p) ??
    titled[0]
  );
}

/**
 * The tab a placement is relative to: the tab its `group` names, else the active (or first) tab.
 * A `group` naming no open tab falls back to the active tab, with a toast saying so.
 */
function placementReference(
  api: DockviewApi,
  placement: PanelPlacement | undefined,
): IDockviewPanel | undefined {
  if (placement?.group) {
    const tab = findPlacementTab(api, placement.group);
    if (tab) return tab;
    showToast(
      `No open tab matches "${placement.group.name}"; placed by the active tab instead`,
      "info",
    );
  }
  return api.activePanel ?? api.panels[0];
}

/**
 * Run a layout change opened without focus, leaving the user where they were. The active tab is
 * activated again if the change activated another: closing an active tab activates its group, and
 * dockview ignores `skipSetActive` for moves into a new split. DOM focus is handed back if the
 * change dropped it: a split can re-parent the focused group's element, which blurs it. A change
 * that closed the active tab (a replace of it) leaves its replacement showing.
 */
function keepingUserFocus<T>(dv: DockviewApi, focus: boolean, change: () => T): T {
  if (focus) return change();
  const active = dv.activePanel;
  const focused = document.activeElement;
  const result = change();
  if (active && dv.activePanel !== active && dv.getPanel(active.id) === active) {
    activatePanel(dv, active);
  }
  if (focused instanceof HTMLElement && focused.isConnected && document.activeElement !== focused) {
    focused.focus({ preventScroll: true });
  }
  return result;
}

/**
 * Where to add a panel relative to `ref`: a tab in its group by default, a new group beside it for
 * `split`, or right after it for `replace` (the caller then closes it).
 */
function placedPosition(
  ref: IDockviewPanel,
  placement: PanelPlacement | undefined,
): AddPanelPositionOptions {
  if (placement?.split) {
    return { referencePanel: ref.id, direction: ADD_DIRECTION[placement.split] };
  }
  if (placement?.replace) {
    return { referenceGroup: ref.group, index: ref.group.panels.indexOf(ref) + 1 };
  }
  return { referencePanel: ref.id, direction: "within" };
}

/**
 * Add a panel where `placement` asks, closing the tab it replaces. With no tab open at all the
 * panel simply opens. Without `focus` it is added without activating it or its group.
 */
function addPlacedPanel(
  dv: DockviewApi,
  placement: PanelPlacement | undefined,
  options: PanelOptions & Pick<AddPanelOptions, "renderer">,
  focus = true,
): IDockviewPanel {
  const ref = placementReference(dv, placement);
  return keepingUserFocus(dv, focus, () => {
    const panel = dv.addPanel({
      ...options,
      position: ref && placedPosition(ref, placement),
      inactive: !focus,
    });
    // A background `renderer: "always"` tab (a browser) detaches the group's shown content.
    if (!focus) reattachActiveContent(panel.group);
    // Added before closing, so a group holding only the replaced tab isn't removed in between.
    if (ref && placement?.replace) ref.api.close();
    return panel;
  });
}

/**
 * Move an open tab where `placement` asks, as {@link addPlacedPanel} would add it (`loxel` naming
 * a file whose tab is already open), and activate it unless opened without `focus`. A tab placed
 * relative to itself only moves for a split, off a group it shares with other tabs (like the
 * `panel.move.new*` actions).
 */
function movePlacedPanel(
  dv: DockviewApi,
  panel: IDockviewPanel,
  placement: PanelPlacement,
  focus: boolean,
): void {
  const ref = placementReference(dv, placement);
  const skipSetActive = !focus;
  keepingUserFocus(dv, focus, () => {
    if (ref === panel) {
      if (placement.split && panel.group.panels.length > 1) {
        panel.api.moveTo({
          group: panel.group,
          position: MOVE_POSITION[placement.split],
          skipSetActive,
        });
      }
    } else if (ref) {
      if (placement.split) {
        panel.api.moveTo({
          group: ref.group,
          position: MOVE_POSITION[placement.split],
          skipSetActive,
        });
      } else if (placement.replace) {
        panel.api.moveTo({
          group: ref.group,
          position: "center",
          index: ref.group.panels.indexOf(ref),
          skipSetActive,
        });
        ref.api.close();
      } else if (panel.group !== ref.group) {
        panel.api.moveTo({ group: ref.group, position: "center", skipSetActive });
      }
    }
  });
  if (focus) activatePanel(dv, panel);
}

// -- Panel creators --

export interface CreateTerminalOptions extends PanelOpenOptions {
  /** Session ID to bind to; minted here when absent. The server names it for `loxel terminal`. */
  terminalId?: string;
  /** Directory the shell starts in; the active worktree when absent. */
  cwd?: string;
  title?: string;
}

export function createTerminal({
  placement,
  focus,
  cwd,
  ...options
}: CreateTerminalOptions = {}): void {
  const cApi = getCenterApi();
  if (!cApi) return;

  const terminalId = options.terminalId ?? crypto.randomUUID();
  const title = options.title ?? nextPanelTitle(cApi, "Terminal");
  const panelId = `terminal-${terminalId}`;

  getCurrentWorktreeToolsBar().getState().addTerminal({ id: panelId, title, terminalId });
  uiLog.info("Panel created", { panelType: "terminal", panelId, terminalId, cwd });

  const worktreePath = useWorktreeStore.getState().activeWorktreePath;
  addPlacedPanel(
    cApi,
    placement,
    {
      id: panelId,
      component: "terminal",
      tabComponent: "terminalTab",
      title,
      params: { terminalId, worktreePath, ...(cwd && cwd !== worktreePath ? { cwd } : {}) },
    },
    focus,
  );
}

export async function createEditor(options?: {
  content?: string;
  title?: string;
  placement?: PanelPlacement;
}): Promise<void> {
  const dv = getCenterApi();
  if (!dv || creatingEditor) return;
  creatingEditor = true;
  try {
    const wt = useWorktreeStore.getState().activeWorktreePath;
    if (!wt) return;
    const { name, path: filePath } = await api.createDetachedFile({
      wt,
      prefix: "Note",
      ext: "md",
      content: options?.content ?? "# ",
    });
    const panelId = `editor-${filePath}`;
    const title = options?.title || name;

    if (options?.content) {
      setEditorContent(filePath, options.content);
    }

    addPlacedPanel(dv, options?.placement, {
      id: panelId,
      component: "editor",
      tabComponent: "markdownEditorTab",
      title,
      params: { filePath, worktreePath: wt },
    });
    uiLog.info("Panel created", { panelType: "editor", panelId, filePath });

    invalidateDetachedFiles();
  } catch (err) {
    uiLog.error("Failed to create editor", { error: err instanceof Error ? err : undefined });
  } finally {
    creatingEditor = false;
  }
}

export async function createDrawing(placement?: PanelPlacement): Promise<void> {
  const dv = getCenterApi();
  if (!dv || creatingDrawing) return;
  creatingDrawing = true;
  try {
    const emptyExcalidraw = JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "loxel",
      elements: [],
      appState: { viewBackgroundColor: "transparent" },
      files: {},
    });
    const wt = useWorktreeStore.getState().activeWorktreePath;
    if (!wt) return;
    const { name, path: filePath } = await api.createDetachedFile({
      wt,
      prefix: "Drawing",
      ext: "excalidraw",
      content: emptyExcalidraw,
    });
    const panelId = `drawing-${filePath}`;

    addPlacedPanel(dv, placement, {
      id: panelId,
      component: "excalidraw",
      tabComponent: "excalidrawEditorTab",
      title: name,
      params: { filePath, worktreePath: wt },
    });
    uiLog.info("Panel created", { panelType: "excalidraw", panelId, filePath });

    invalidateDetachedFiles();
  } catch (err) {
    uiLog.error("Failed to create drawing", { error: err instanceof Error ? err : undefined });
  } finally {
    creatingDrawing = false;
  }
}

/** A new browser panel showing `url`, for `addPanel`. */
function browserPanelOptions(
  cApi: DockviewApi,
  url: string,
): PanelOptions & Pick<AddPanelOptions, "renderer"> {
  return {
    id: `browser-${crypto.randomUUID()}`,
    component: "browser",
    tabComponent: "browserTab",
    title: nextPanelTitle(cApi, "Browser"),
    params: { url },
    // Keep the <webview> attached while hidden or moved: re-attaching it reloads the page.
    renderer: "always",
  };
}

export function createBrowser(url?: string, { placement, focus }: PanelOpenOptions = {}): void {
  const cApi = getCenterApi();
  if (!cApi) return;
  const options = browserPanelOptions(cApi, url || "about:blank");
  addPlacedPanel(cApi, placement, options, focus);
  uiLog.info("Panel created", { panelType: "browser", panelId: options.id });
}

export interface OpenBrowserTabOptions {
  /** The browser panel the URL came from: the new tab opens right after it, in its group. */
  sourcePanelId: string;
  /** Focus the new tab. By default it opens in the background, like a browser's new-tab links. */
  activate?: boolean;
}

/** The tab most recently opened from each browser panel, so repeated opens keep their order. */
const lastTabOpenedFrom = new Map<string, string>();

/** Open a URL in a new browser tab next to the browser panel it came from. */
export function openBrowserTab(
  url: string,
  { sourcePanelId, activate = false }: OpenBrowserTabOptions,
): void {
  const cApi = getCenterApi();
  if (!cApi) return;
  const source = cApi.getPanel(sourcePanelId);
  if (!source) {
    createBrowser(url);
    return;
  }

  // Go after the tab last opened from the source if it is still to the source's right, so links
  // opened one after another line up in the order they were opened.
  const tabs = source.group.panels;
  const sourceIndex = tabs.indexOf(source);
  const lastOpenedIndex = tabs.findIndex((p) => p.id === lastTabOpenedFrom.get(sourcePanelId));
  const index = Math.max(sourceIndex, lastOpenedIndex) + 1;

  const options = browserPanelOptions(cApi, url);
  cApi.addPanel({
    ...options,
    position: { referenceGroup: source.group, direction: "within", index },
    inactive: !activate,
  });
  uiLog.info("Panel created", { panelType: "browser", panelId: options.id });
  lastTabOpenedFrom.set(sourcePanelId, options.id);
}

export function createAgent(placement?: PanelPlacement): void {
  const cApi = getCenterApi();
  if (!cApi) return;

  const sessionId = crypto.randomUUID();
  const panelId = `agent-${sessionId}`;
  const title = nextPanelTitle(cApi, "Agent");

  const worktreePath = useWorktreeStore.getState().activeWorktreePath;
  addPlacedPanel(cApi, placement, {
    id: panelId,
    component: "codingAgent",
    tabComponent: "codingAgentTab",
    title,
    params: { sessionId, worktreePath },
  });
  uiLog.info("Panel created", { panelType: "agent", panelId, sessionId });
}

/** Open a panel for a forked coding-agent session. Deduplicates — focuses existing if found. */
export function openForkedAgent(forkedSessionId: string, forkPointMessageId?: string): void {
  const cApi = getCenterApi();
  if (!cApi) return;

  // Dedup: focus existing panel if one already exists for this forked session
  const existing = cApi.panels.find((p) => {
    const params = p.params;
    return (
      typeof params === "object" &&
      params !== null &&
      (params as Record<string, unknown>).forkedSessionId === forkedSessionId
    );
  });
  if (existing) {
    activatePanel(cApi, existing);
    return;
  }

  const sessionId = crypto.randomUUID();
  const panelId = `agent-${sessionId}`;
  const title = nextPanelTitle(cApi, "Agent");

  const worktreePath = useWorktreeStore.getState().activeWorktreePath;
  addPlacedPanel(cApi, undefined, {
    id: panelId,
    component: "codingAgent",
    tabComponent: "codingAgentTab",
    title,
    params: { sessionId, worktreePath, forkedSessionId, forkPointMessageId },
  });
  uiLog.info("Panel created (fork)", { panelType: "agent", panelId, sessionId, forkedSessionId });
}

export function openAgentDevtools(sessionId: string): void {
  const dv = getCenterApi();
  if (!dv) return;

  const panelId = `agentdevtools-${sessionId}`;
  const existing = dv.getPanel(panelId);
  if (existing) {
    activatePanel(dv, existing);
    return;
  }

  const agentPanel = dv.getPanel(`agent-${sessionId}`);
  const options = {
    id: panelId,
    component: "agentDevTools",
    tabComponent: "agentDevToolsTab",
    title: "DevTools",
    params: { sessionId },
  };
  if (agentPanel) {
    dv.addPanel({ ...options, position: { referencePanel: agentPanel.id, direction: "right" } });
  } else {
    addPlacedPanel(dv, undefined, options);
  }
}

export async function createCodeEditor(options?: {
  ext?: string;
  placement?: PanelPlacement;
}): Promise<void> {
  const dv = getCenterApi();
  if (!dv || creatingCodeEditor) return;
  creatingCodeEditor = true;
  try {
    const wt = useWorktreeStore.getState().activeWorktreePath;
    if (!wt) return;
    const { name, path: filePath } = await api.createDetachedFile({
      wt,
      prefix: "Untitled",
      ext: options?.ext,
      content: "",
    });
    const panelId = `codeeditor-${filePath}`;

    addPlacedPanel(dv, options?.placement, {
      id: panelId,
      component: "codeEditor",
      tabComponent: "codeEditorTab",
      title: name,
      params: { filePath, worktreePath: wt },
    });
    uiLog.info("Panel created", { panelType: "codeEditor", panelId, filePath });

    invalidateDetachedFiles();
  } catch (err) {
    uiLog.error("Failed to create code editor", { error: err instanceof Error ? err : undefined });
  } finally {
    creatingCodeEditor = false;
  }
}

// -- File-backed panel opener --

/** An exact slot for a new file-backed panel, e.g. a moved file's tab taking its old tab's place. */
type FileBackedSlot = Required<Pick<AddPanelOptions, "position" | "inactive">>;

interface OpenFileBackedOptions extends PanelOpenOptions {
  params?: { line?: number; column?: number; movedFrom?: string };
  /** Where a new tab goes, overriding `placement`. */
  slot?: FileBackedSlot;
}

/**
 * Open or focus a file-backed center panel, deduplicating by path. Returns the panel, or
 * undefined when there is no center layout.
 */
export function openFileBacked(
  type: FilePanelType,
  filePath: string,
  { params, slot, placement, focus = true }: OpenFileBackedOptions = {},
): IDockviewPanel | undefined {
  const cApi = getCenterApi();
  if (!cApi) return undefined;
  const def = getCenterPanelDefByType(type);
  if (!def) return undefined;
  const panelId = `${def.idPrefix}${filePath}`;
  const existing = cApi.getPanel(panelId);
  if (existing) {
    if (placement) movePlacedPanel(cApi, existing, placement, focus);
    else if (focus) activatePanel(cApi, existing);
    if (params?.line) {
      existing.api.updateParameters({ line: params.line, column: params.column });
    }
    return existing;
  }
  const options = {
    id: panelId,
    component: def.component,
    tabComponent: def.tabComponent,
    title: getDisplayFilename(filePath),
    params: { filePath, worktreePath: useWorktreeStore.getState().activeWorktreePath, ...params },
  };
  return slot
    ? cApi.addPanel({ ...options, ...slot })
    : addPlacedPanel(cApi, placement, options, focus);
}

// -- File lifecycle handlers --

function getPanelFilePath(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null || !("filePath" in params)) return undefined;
  const { filePath } = params as Record<string, unknown>;
  return typeof filePath === "string" ? filePath : undefined;
}

/** Old paths whose move is being applied; a second report of the same move is ignored. */
const movesInProgress = new Set<string>();

/**
 * Handle file-moved events: migrate caches and replace the old panel with one for the new path
 * in the old tab's place. The new tab is visible only if the old one was, and the move never
 * changes which group is active. Idempotent: an in-app move is reported both locally and by the
 * server, and the second report finds the move in progress or no tab on the old path.
 *
 * Unsaved edits are carried to the new path (see `carryPendingEdit`); if they conflict with
 * what is now on disk there, the tab is not moved and shows its old path as deleted.
 *
 * `announce` (a move made outside Loxel) records the old path in the new tab's `movedFrom`
 * parameter, which its editor shows until dismissed. Resolves to whether the tab was replaced.
 */
export async function handleFileMoved(
  oldPath: string,
  newPath: string,
  options?: { announce?: boolean },
): Promise<boolean> {
  const dv = getCenterApi();
  if (!dv || movesInProgress.has(oldPath)) return false;
  markOtherViewsDeleted(oldPath);

  const oldPanel = dv.panels.find((p) => getPanelFilePath(p.params) === oldPath);
  if (!oldPanel) return false;

  // An editor in conflict holds edits that may not overwrite the disk version, so it cannot be
  // carried over by saving; it stays on the old path, which then shows as deleted.
  const store = useEditorStateStore.getState();
  if (store.files.get(oldPath)?.state === "diverged") return false;

  // A tab already open on the new path (e.g. for a file deleted outside the app) keeps its own
  // state. A clean old tab is just dropped; one with unsaved edits stays on its old path, shown
  // as deleted, since there is no tab to carry the edits into.
  if (dv.panels.some((p) => getPanelFilePath(p.params) === newPath)) {
    const oldState = store.files.get(oldPath)?.state;
    if (oldState === "dirty" || oldState === "saving") {
      store.setDeleted(oldPath, true);
      return false;
    }
    store.closeFile(oldPath);
    oldPanel.api.close();
    return false;
  }

  movesInProgress.add(oldPath);
  try {
    // From here on the old path's autosave and disk events no longer apply.
    store.setMovedTo(oldPath, newPath);
    const state = store.files.get(oldPath)?.state;
    if (state === "dirty" || state === "saving") {
      const carried = await carryPendingEdit(oldPath, newPath, getPanelWorktreePath(oldPanel));
      if (!carried) {
        const current = useEditorStateStore.getState();
        current.setMovedTo(oldPath, null);
        current.setDeleted(oldPath, true);
        return false;
      }
    }
    return replaceMovedPanel(dv, oldPath, newPath, options?.announce ?? false);
  } finally {
    movesInProgress.delete(oldPath);
  }
}

/**
 * Write the old editor's unsaved edits to the new path before a tab exists there, so they reach
 * the new editor as plain disk content rather than as a save it never made. Reads the new path
 * first: if another program changed the file since the editor last saw it, the edits are
 * three-way merged onto that version. Resolves false on a conflict, a failed read or a failed
 * write, leaving the edits in the old editor.
 */
async function carryPendingEdit(
  oldPath: string,
  newPath: string,
  worktreePath: string | null,
): Promise<boolean> {
  let onDisk: string;
  try {
    ({ content: onDisk } = await api.getFileContentByPath(newPath, worktreePath));
  } catch (error: unknown) {
    filesLog.warn("Could not read a moved file; leaving its tab in place", { error, newPath });
    return false;
  }
  // Taken after the read, so edits typed meanwhile are included (autosave is off while moving).
  const entry = useEditorStateStore.getState().files.get(oldPath);
  const pending = entry?.takePendingEdit?.() ?? null;
  if (!entry || !pending) return true;

  // Our own versions: the last clean content, and any save of ours that landed before the move.
  const own = [entry.baseContent, ...entry.savedSnapshots.values()];
  let content = pending.content;
  if (!own.includes(onDisk)) {
    // No merge base means the editor never reconciled with disk, so its buffer may not be a
    // version of this file at all: never overwrite a change it has not seen (as `tryAutoMerge`).
    if (entry.baseContent === null) return false;
    const merged = threeWayMerge(entry.baseContent, pending.content, onDisk);
    if (!merged.ok) return false;
    content = merged.merged;
  }
  // Awaited: if the write fails, the edits must stay in the old tab rather than be dropped.
  return saveEditorContent(newPath, content, worktreePath, pending.options);
}

/** Open the moved file's tab in the old tab's place and close the old one. */
function replaceMovedPanel(
  dv: DockviewApi,
  oldPath: string,
  newPath: string,
  announce: boolean,
): boolean {
  // The old tab may have closed, or the new path opened, while the moved file was read.
  const oldPanel = dv.panels.find((p) => getPanelFilePath(p.params) === oldPath);
  if (!oldPanel) return false;
  if (dv.panels.some((p) => getPanelFilePath(p.params) === newPath)) {
    oldPanel.api.close();
    return false;
  }

  renameEditorCacheKey(oldPath, newPath);
  renameDrawingCacheKey(oldPath, newPath);

  // Add the new panel before closing the old one, so a group holding only the old panel
  // isn't removed from the layout in between.
  const { group } = oldPanel;
  const wasVisible = group.activePanel === oldPanel;
  const newPanel = openFileBacked(filePanelType(newPath), newPath, {
    params: announce ? { movedFrom: oldPath } : undefined,
    slot: {
      position: { referenceGroup: group, index: group.panels.indexOf(oldPanel) + 1 },
      inactive: true,
    },
  });
  if (newPanel && wasVisible) {
    if (dv.activeGroup === group) {
      activatePanel(dv, newPanel);
    } else {
      group.model.openPanel(newPanel, { skipSetGroupActive: true });
    }
  }
  oldPanel.api.close();
  return newPanel !== undefined;
}

/**
 * Editors of a file other than its own tab (compare panel sides) stay on a path that was deleted
 * or moved away. Mark them deleted right away, before their content query notices, so a pending
 * autosave cannot re-create the file.
 */
function markOtherViewsDeleted(path: string): void {
  const store = useEditorStateStore.getState();
  for (const [key, entry] of store.files) {
    if (key !== entry.filePath && isWithin(entry.filePath, path)) store.setDeleted(key, true);
  }
}

/** Handle file-deleted events: close any open panel for the deleted file/directory. */
export function handleFileDeleted(filePath: string): void {
  const dv = getCenterApi();
  if (!dv) return;
  markOtherViewsDeleted(filePath);

  for (const panel of dv.panels) {
    const panelPath = getPanelFilePath(panel.params);
    if (panelPath === filePath || panelPath?.startsWith(filePath + "/")) {
      useEditorStateStore.getState().closeFile(panelPath);
      panel.api.close();
    }
  }
}

/** Handle open-diff events: open or focus the singleton diff panel. */
export function openDiff(): void {
  const cApi = getCenterApi();
  if (!cApi) return;

  const existing = cApi.getPanel("diff");
  if (existing) {
    activatePanel(cApi, existing);
    return;
  }

  const ref = cApi.activePanel ?? cApi.panels[0];
  cApi.addPanel({
    id: "diff",
    component: "diff",
    tabComponent: "diffTab",
    title: "Diff",
    position: ref ? { referencePanel: ref.id, direction: "within" } : undefined,
  });
}

/** Open a panel comparing two files; every comparison gets its own panel. */
export function openCompareFiles(
  oldPath: string,
  newPath: string,
  placement?: PanelPlacement,
): void {
  const cApi = getCenterApi();
  if (!cApi) return;

  const panelId = `compare-${crypto.randomUUID()}`;
  const worktreePath = useWorktreeStore.getState().activeWorktreePath;
  addPlacedPanel(cApi, placement, {
    id: panelId,
    component: "compare",
    tabComponent: "compareTab",
    title: `${getDisplayFilename(oldPath)} ↔ ${getDisplayFilename(newPath)}`,
    params: { oldPath, newPath, worktreePath },
  });
  uiLog.info("Panel created", { panelType: "compare", panelId, oldPath, newPath });
}

/**
 * Split or new-tab actions on a compare panel carry no paths: open the same comparison again
 * next to the panel the placement is relative to (the active one by default).
 */
export function duplicateComparison(placement?: PanelPlacement): void {
  const cApi = getCenterApi();
  if (!cApi) return;
  const params: unknown = placementReference(cApi, placement)?.params;
  if (typeof params !== "object" || params === null) return;
  const { oldPath, newPath } = params as Record<string, unknown>;
  if (typeof oldPath !== "string" || typeof newPath !== "string") return;
  openCompareFiles(oldPath, newPath, placement);
}

/** Open or focus the singleton LocalDb panel. */
export function openLocalDb(): void {
  const cApi = getCenterApi();
  if (!cApi) return;

  const existing = cApi.getPanel("localdb-main");
  if (existing) {
    activatePanel(cApi, existing);
    return;
  }

  const ref = cApi.activePanel ?? cApi.panels[0];
  cApi.addPanel({
    id: "localdb-main",
    component: "localDb",
    tabComponent: "localDbTab",
    title: "Database",
    position: ref ? { referencePanel: ref.id, direction: "within" } : undefined,
  });
}
