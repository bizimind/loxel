/**
 * Imperative panel creation and lifecycle functions.
 *
 * These operate on the center dockview API via getCenterApi() and read from
 * Zustand stores directly. They are module-level (not React hooks) because
 * they must run outside the React render cycle (event handlers, store actions).
 */
import type { DockviewApi } from "dockview-react";

import * as api from "@/api/client";
import type { SplitPosition } from "@/components/dockview/default-layout";
import { nextPanelTitle } from "@/components/dockview/default-layout";
import { renameEditorCacheKey, setEditorContent } from "@/components/editor/MarkdownEditor";
import { renameDrawingCacheKey } from "@/components/excalidraw-editor/ExcalidrawEditor";
import { getDisplayFilename } from "@/lib/detached-path";
import { frontendLog } from "@/lib/frontend-logger";
import { isMediaFile } from "@/lib/media-extensions";
import { queryKeys } from "@/queries/query-keys";
import { getQueryScope } from "@/queries/use-scope";
import { queryClient } from "@/query-client";
import { useEditorStateStore } from "@/store/editor-state";
import { getCenterPanelDefByType } from "@/store/panel-config";
import { getCenterApi } from "@/store/tools-bar";
import { getCurrentWorktreeToolsBar } from "@/store/worktree-tools-bar";
import { useWorktreeStore } from "@/store/worktrees";

const uiLog = frontendLog.child("ui");

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

export function createTerminal(split?: SplitPosition): void {
  const cApi = getCenterApi();
  if (!cApi) return;

  const terminalId = crypto.randomUUID();
  const title = nextPanelTitle(cApi, "Terminal");
  const panelId = `terminal-${terminalId}`;

  getCurrentWorktreeToolsBar().getState().addTerminal({ id: panelId, title, terminalId });
  uiLog.info("Panel created", { panelType: "terminal", panelId, terminalId });

  const worktreePath = useWorktreeStore.getState().activeWorktreePath;
  cApi.addPanel({
    id: panelId,
    component: "terminal",
    tabComponent: "terminalTab",
    title,
    params: { terminalId, worktreePath },
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
    existing.api.setActive();
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
    existing.api.setActive();
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

/** Open or focus a file-backed center panel, deduplicating by path. */
export function openFileBacked(
  type: "editor" | "codeEditor" | "excalidraw" | "media",
  filePath: string,
  extra?: { line?: number; column?: number },
): void {
  const cApi = getCenterApi();
  if (!cApi) return;
  const def = getCenterPanelDefByType(type);
  if (!def) return;
  const panelId = `${def.idPrefix}${filePath}`;
  const existing = cApi.getPanel(panelId);
  if (existing) {
    existing.api.setActive();
    if (extra?.line) {
      existing.api.updateParameters({ line: extra.line, column: extra.column });
    }
    return;
  }
  const filename = getDisplayFilename(filePath);
  const worktreePath = useWorktreeStore.getState().activeWorktreePath;
  const ref = cApi.activePanel ?? cApi.panels[0];
  cApi.addPanel({
    id: panelId,
    component: def.component,
    tabComponent: def.tabComponent,
    title: filename,
    params: { filePath, worktreePath, ...extra },
    position: ref ? { referencePanel: ref.id, direction: "within" } : undefined,
  });
}

// -- File lifecycle handlers --

function getPanelFilePath(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null || !("filePath" in params)) return undefined;
  const { filePath } = params as Record<string, unknown>;
  return typeof filePath === "string" ? filePath : undefined;
}

/** Handle file-moved events: close old panel, migrate caches, reopen at new path. */
export function handleFileMoved(oldPath: string, newPath: string): void {
  const dv = getCenterApi();
  if (!dv) return;

  const oldPanel = dv.panels.find((p) => getPanelFilePath(p.params) === oldPath);

  if (oldPanel) {
    renameEditorCacheKey(oldPath, newPath);
    renameDrawingCacheKey(oldPath, newPath);

    useEditorStateStore.getState().closeFile(oldPath);
    oldPanel.api.close();

    if (newPath.endsWith(".md")) {
      openFileBacked("editor", newPath);
    } else if (newPath.endsWith(".excalidraw")) {
      openFileBacked("excalidraw", newPath);
    } else if (isMediaFile(newPath)) {
      openFileBacked("media", newPath);
    } else {
      openFileBacked("codeEditor", newPath);
    }
  }
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
    existing.api.setActive();
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
    existing.api.setActive();
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
