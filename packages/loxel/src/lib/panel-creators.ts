/**
 * Imperative panel creation and lifecycle functions.
 *
 * These operate on the center dockview API via getCenterApi() and read from
 * Zustand stores directly. They are module-level (not React hooks) because
 * they must run outside the React render cycle (event handlers, store actions).
 */
import type { AddPanelOptions, DockviewApi, IDockviewPanel } from "dockview-react";

import * as api from "@/api/client";
import type { SplitPosition } from "@/components/dockview/default-layout";
import { nextPanelTitle } from "@/components/dockview/default-layout";
import { renameEditorCacheKey, setEditorContent } from "@/components/editor/MarkdownEditor";
import { renameDrawingCacheKey } from "@/components/excalidraw-editor/ExcalidrawEditor";
import { getDisplayFilename } from "@/lib/detached-path";
import { frontendLog } from "@/lib/frontend-logger";
import { filePanelType } from "@/lib/open-file";
import type { FilePanelType } from "@/lib/open-file";
import { saveEditorContent } from "@/lib/save-editor-content";
import { threeWayMerge } from "@/lib/three-way-merge";
import { queryKeys } from "@/queries/query-keys";
import { getQueryScope } from "@/queries/use-scope";
import { queryClient } from "@/query-client";
import { useEditorStateStore } from "@/store/editor-state";
import { activatePanel } from "@/store/layout-actions";
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

// -- Helpers --

/** Use the explicit split position, or fall back to "within" the active/first panel. */
function panelPosition(api: DockviewApi, split?: SplitPosition) {
  if (split) return split;
  const ref = api.activePanel ?? api.panels[0];
  return ref ? { referencePanel: ref.id, direction: "within" as const } : undefined;
}

// -- Panel creators --

export interface CreateTerminalOptions {
  split?: SplitPosition;
  /** Session ID to bind to; minted here when absent. The server names it for `loxel terminal`. */
  terminalId?: string;
  /** Directory the shell starts in; the active worktree when absent. */
  cwd?: string;
  title?: string;
}

export function createTerminal({ split, cwd, ...options }: CreateTerminalOptions = {}): void {
  const cApi = getCenterApi();
  if (!cApi) return;

  const terminalId = options.terminalId ?? crypto.randomUUID();
  const title = options.title ?? nextPanelTitle(cApi, "Terminal");
  const panelId = `terminal-${terminalId}`;

  getCurrentWorktreeToolsBar().getState().addTerminal({ id: panelId, title, terminalId });
  uiLog.info("Panel created", { panelType: "terminal", panelId, terminalId, cwd });

  const worktreePath = useWorktreeStore.getState().activeWorktreePath;
  cApi.addPanel({
    id: panelId,
    component: "terminal",
    tabComponent: "terminalTab",
    title,
    params: { terminalId, worktreePath, ...(cwd && cwd !== worktreePath ? { cwd } : {}) },
    position: panelPosition(cApi, split),
  });
}

export async function createEditor(options?: {
  content?: string;
  title?: string;
  split?: SplitPosition;
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

    dv.addPanel({
      id: panelId,
      component: "editor",
      tabComponent: "markdownEditorTab",
      title,
      params: { filePath, worktreePath: wt },
      position: panelPosition(dv, options?.split),
    });
    uiLog.info("Panel created", { panelType: "editor", panelId, filePath });

    invalidateDetachedFiles();
  } catch (err) {
    uiLog.error("Failed to create editor", { error: err instanceof Error ? err : undefined });
  } finally {
    creatingEditor = false;
  }
}

export async function createDrawing(split?: SplitPosition): Promise<void> {
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

    dv.addPanel({
      id: panelId,
      component: "excalidraw",
      tabComponent: "excalidrawEditorTab",
      title: name,
      params: { filePath, worktreePath: wt },
      position: panelPosition(dv, split),
    });
    uiLog.info("Panel created", { panelType: "excalidraw", panelId, filePath });

    invalidateDetachedFiles();
  } catch (err) {
    uiLog.error("Failed to create drawing", { error: err instanceof Error ? err : undefined });
  } finally {
    creatingDrawing = false;
  }
}

export function createBrowser(url?: string, split?: SplitPosition): void {
  const cApi = getCenterApi();
  if (!cApi) return;

  const panelId = `browser-${crypto.randomUUID()}`;
  const title = nextPanelTitle(cApi, "Browser");
  const targetUrl = url || "about:blank";

  cApi.addPanel({
    id: panelId,
    component: "browser",
    tabComponent: "browserTab",
    title,
    params: { url: targetUrl },
    position: panelPosition(cApi, split),
    // Keep the <webview> attached while hidden or moved: re-attaching it reloads the page.
    renderer: "always",
  });
  uiLog.info("Panel created", { panelType: "browser", panelId });
}

export function createAgent(split?: SplitPosition): void {
  const cApi = getCenterApi();
  if (!cApi) return;

  const sessionId = crypto.randomUUID();
  const panelId = `agent-${sessionId}`;
  const title = nextPanelTitle(cApi, "Agent");

  const worktreePath = useWorktreeStore.getState().activeWorktreePath;
  cApi.addPanel({
    id: panelId,
    component: "codingAgent",
    tabComponent: "codingAgentTab",
    title,
    params: { sessionId, worktreePath },
    position: panelPosition(cApi, split),
  });
  uiLog.info("Panel created", { panelType: "agent", panelId, sessionId });
}

/** Open a panel for a forked coding-agent session. Deduplicates — focuses existing if found. */
export function openForkedAgent(
  forkedSessionId: string,
  forkPointMessageId?: string,
  split?: SplitPosition,
): void {
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
  cApi.addPanel({
    id: panelId,
    component: "codingAgent",
    tabComponent: "codingAgentTab",
    title,
    params: { sessionId, worktreePath, forkedSessionId, forkPointMessageId },
    position: panelPosition(cApi, split),
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
  const position = agentPanel
    ? { referencePanel: agentPanel.id, direction: "right" as const }
    : panelPosition(dv);

  dv.addPanel({
    id: panelId,
    component: "agentDevTools",
    tabComponent: "agentDevToolsTab",
    title: "DevTools",
    params: { sessionId },
    position,
  });
}

export async function createCodeEditor(options?: {
  ext?: string;
  split?: SplitPosition;
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

    dv.addPanel({
      id: panelId,
      component: "codeEditor",
      tabComponent: "codeEditorTab",
      title: name,
      params: { filePath, worktreePath: wt },
      position: panelPosition(dv, options?.split),
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

/** Where to add a new file-backed panel; defaults to an active tab after the active panel. */
type FileBackedPlacement = Required<Pick<AddPanelOptions, "position" | "inactive">>;

/**
 * Open or focus a file-backed center panel, deduplicating by path. Returns the panel, or
 * undefined when there is no center layout.
 */
export function openFileBacked(
  type: FilePanelType,
  filePath: string,
  extra?: { line?: number; column?: number; movedFrom?: string },
  placement?: FileBackedPlacement,
): IDockviewPanel | undefined {
  const cApi = getCenterApi();
  if (!cApi) return undefined;
  const def = getCenterPanelDefByType(type);
  if (!def) return undefined;
  const panelId = `${def.idPrefix}${filePath}`;
  const existing = cApi.getPanel(panelId);
  if (existing) {
    activatePanel(cApi, existing);
    if (extra?.line) {
      existing.api.updateParameters({ line: extra.line, column: extra.column });
    }
    return existing;
  }
  const filename = getDisplayFilename(filePath);
  const worktreePath = useWorktreeStore.getState().activeWorktreePath;
  const ref = cApi.activePanel ?? cApi.panels[0];
  return cApi.addPanel({
    id: panelId,
    component: def.component,
    tabComponent: def.tabComponent,
    title: filename,
    params: { filePath, worktreePath, ...extra },
    position: ref ? { referencePanel: ref.id, direction: "within" } : undefined,
    ...placement,
  });
}

// -- File lifecycle handlers --

function getPanelWorktreePath(panel: IDockviewPanel): string | null {
  const params: unknown = panel.params;
  if (typeof params !== "object" || params === null || !("worktreePath" in params)) return null;
  const { worktreePath } = params as Record<string, unknown>;
  return typeof worktreePath === "string" ? worktreePath : null;
}

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

  const oldPanel = dv.panels.find((p) => getPanelFilePath(p.params) === oldPath);
  if (!oldPanel) return false;

  // An editor in conflict holds edits that may not overwrite the disk version, so it cannot be
  // carried over by saving; it stays on the old path, which then shows as deleted.
  const store = useEditorStateStore.getState();
  if (store.files.get(oldPath)?.state === "diverged") return false;

  // A tab already open on the new path (e.g. for a file deleted outside the app) keeps its own
  // state; just drop the old tab, and with it any unsaved edit.
  if (dv.panels.some((p) => getPanelFilePath(p.params) === newPath)) {
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
  const newPanel = openFileBacked(
    filePanelType(newPath),
    newPath,
    announce ? { movedFrom: oldPath } : undefined,
    {
      position: { referenceGroup: group, index: group.panels.indexOf(oldPanel) + 1 },
      inactive: true,
    },
  );
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

/** Handle file-deleted events: close any open panel for the deleted file/directory. */
export function handleFileDeleted(filePath: string): void {
  const dv = getCenterApi();
  if (!dv) return;

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
