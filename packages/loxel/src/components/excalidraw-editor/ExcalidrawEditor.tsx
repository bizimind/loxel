import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
/**
 * Excalidraw drawing editor with file persistence.
 * Content is cached per filePath across layout swaps, with disk as source of truth.
 */
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { DockviewPanelApi } from "dockview-react";

import { lazy, Suspense, useCallback, useEffect, useRef } from "react";

import { ConflictBanner } from "@/components/editor/ConflictBanner";
import { useDiskSyncedContent } from "@/hooks/use-disk-synced-content";
import { usePanelActivationFocus } from "@/hooks/usePanelActivationFocus";
import { useEditorStateStore } from "@/store/editor-state";
import { useUIStore } from "@/store/ui";
import "@/styles/excalidraw-theme.css";

/** Lazy-loaded wrapper that renders Excalidraw with a custom MainMenu (no Open/Save/links). */
const ExcalidrawWithMenu = lazy(() =>
  Promise.all([import("@excalidraw/excalidraw"), import("@excalidraw/excalidraw/index.css")]).then(
    ([mod]) => {
      const { Excalidraw, MainMenu } = mod;
      function ExcalidrawCustomMenu(props: React.ComponentProps<typeof Excalidraw>) {
        return (
          <Excalidraw {...props}>
            <MainMenu>
              <MainMenu.DefaultItems.SaveAsImage />
              <MainMenu.DefaultItems.SearchMenu />
              <MainMenu.DefaultItems.Help />
              <MainMenu.DefaultItems.ClearCanvas />
              <MainMenu.Separator />
              <MainMenu.DefaultItems.ChangeCanvasBackground />
            </MainMenu>
          </Excalidraw>
        );
      }
      return { default: ExcalidrawCustomMenu };
    },
  ),
);

/** Sum of element versions — equivalent to excalidraw's getSceneVersion, inlined to avoid static import. */
function sceneVersion(elements: readonly { version: number }[]): number {
  let v = 0;
  for (const el of elements) v += el.version;
  return v;
}

interface ExcalidrawData {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
}

/**
 * In-memory content cache keyed by absolute path (project root + filePath).
 * Secondary cache — disk is source of truth.
 * Preserves drawing content across layout swaps.
 */
const drawingContentCache = new Map<string, ExcalidrawData>();

/** Pre-seed the content cache so a new drawing opens with the given data. */
export function setDrawingContent(key: string, data: ExcalidrawData): void {
  drawingContentCache.set(key, data);
}

/** Migrate a cache entry when a file is moved (e.g., draft → project). */
export function renameDrawingCacheKey(oldPath: string, newPath: string): void {
  const content = drawingContentCache.get(oldPath);
  if (content !== undefined) {
    drawingContentCache.set(newPath, content);
    drawingContentCache.delete(oldPath);
  }
}

/**
 * Module-level flag set during layout teardown to suppress onChange handlers.
 * Excalidraw fires onChange with empty elements during api.clear(), which would
 * corrupt the cache and schedule saves of empty content. This flag prevents
 * handleChange from processing those events.
 */
let drawingTeardownActive = false;

/**
 * Snapshot all drawing cache entries, run the callback, then fully restore them.
 * Excalidraw fires onChange with empty elements during teardown (api.clear),
 * which corrupts the cache. Full restore is required (not selective) because
 * with absolute-path cache keys, teardown may write corrupt entries under
 * new-scope keys that wouldn't exist in the snapshot.
 *
 * The drawingTeardownActive flag suppresses onChange handlers during the callback,
 * preventing markDirty / autosave scheduling of corrupt data.
 */
export function withDrawingCachePreserved(callback: () => void): void {
  const snapshot = new Map(drawingContentCache);
  drawingTeardownActive = true;
  try {
    callback();
  } finally {
    drawingTeardownActive = false;
    drawingContentCache.clear();
    for (const [id, data] of snapshot) {
      drawingContentCache.set(id, data);
    }
  }
}

/** Serialize ExcalidrawData to .excalidraw JSON format. */
function serializeExcalidraw(data: ExcalidrawData): string {
  return JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "loxel",
      elements: data.elements,
      appState: { viewBackgroundColor: data.appState.viewBackgroundColor ?? "transparent" },
      files: data.files,
    },
    null,
    2,
  );
}

const EMPTY_DATA: ExcalidrawData = {
  elements: [],
  appState: { viewBackgroundColor: "transparent" },
  files: {},
};

/** Deserialize .excalidraw JSON to ExcalidrawData with runtime validation. */
function deserializeExcalidraw(content: string): ExcalidrawData {
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null) return EMPTY_DATA;

  const obj = parsed as Record<string, unknown>;

  // Validate elements: must be an array of objects with at least id, type, version
  let elements: ExcalidrawElement[] = [];
  if (Array.isArray(obj.elements)) {
    elements = obj.elements.filter(
      (el): el is ExcalidrawElement =>
        typeof el === "object" &&
        el !== null &&
        typeof (el as Record<string, unknown>).id === "string" &&
        typeof (el as Record<string, unknown>).type === "string" &&
        typeof (el as Record<string, unknown>).version === "number",
    );
  }

  // Validate appState: must be an object, extract only known-safe fields
  let appState: Partial<AppState> = { viewBackgroundColor: "transparent" };
  if (typeof obj.appState === "object" && obj.appState !== null) {
    const raw = obj.appState as Record<string, unknown>;
    if (typeof raw.viewBackgroundColor === "string") {
      appState = { viewBackgroundColor: raw.viewBackgroundColor };
    }
  }

  // Validate files: BinaryFileData requires id, dataURL, mimeType, created
  let files: BinaryFiles = {};
  if (typeof obj.files === "object" && obj.files !== null && !Array.isArray(obj.files)) {
    const raw = obj.files as Record<string, unknown>;
    const validated: BinaryFiles = {};
    for (const [key, val] of Object.entries(raw)) {
      if (typeof val !== "object" || val === null) continue;
      const f = val as Record<string, unknown>;
      if (
        typeof f.id === "string" &&
        typeof f.dataURL === "string" &&
        typeof f.mimeType === "string" &&
        typeof f.created === "number"
      ) {
        validated[key] = val as BinaryFiles[string];
      }
    }
    files = validated;
  }

  return { elements, appState, files };
}

/** Apply ExcalidrawData to the Excalidraw imperative API. */
function applyScene(
  apiRef: React.MutableRefObject<ExcalidrawImperativeAPI | null>,
  data: ExcalidrawData,
): void {
  const scene: Record<string, unknown> = { elements: data.elements };
  if (data.appState.viewBackgroundColor !== undefined) {
    scene.appState = { viewBackgroundColor: data.appState.viewBackgroundColor };
  }
  apiRef.current?.updateScene(
    scene as Parameters<NonNullable<typeof apiRef.current>["updateScene"]>[0],
  );
}

interface ExcalidrawEditorProps {
  filePath: string;
  onClose?: () => void;
  onCreateNew?: () => void;
  panelApi: DockviewPanelApi;
}

export function ExcalidrawEditor({
  filePath,
  onClose,
  onCreateNew,
  panelApi,
}: ExcalidrawEditorProps) {
  const darkMode = useUIStore((s) => s.darkMode);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastVersionRef = useRef(0);
  const excalidrawApiRef = useRef<ExcalidrawImperativeAPI | null>(null);

  // Excalidraw has no imperative focus API; focusing the canvas container is
  // enough for keyboard shortcuts (delete/arrow keys/zoom) to work.
  usePanelActivationFocus(
    panelApi,
    useCallback(() => {
      const el = containerRef.current?.querySelector<HTMLElement>(".excalidraw__canvas");
      (el ?? containerRef.current)?.focus();
    }, []),
  );

  const onCloseRef = useRef(onClose);
  const onCreateNewRef = useRef(onCreateNew);
  onCloseRef.current = onClose;
  onCreateNewRef.current = onCreateNew;

  const {
    diskContent,
    editorFileState,
    cacheKey,
    isError,
    saveNow,
    handleAcceptDisk: hookAcceptDisk,
    handleKeepMine,
    handleChange: hookHandleChange,
    isProgrammaticRef,
    getSerializedContentRef,
  } = useDiskSyncedContent<ExcalidrawData>({
    filePath,
    deserialize: deserializeExcalidraw,
    contentCache: drawingContentCache,
  });

  // Set getSerializedContent — reads from cache and serializes
  const cacheKeyRef = useRef(cacheKey);
  cacheKeyRef.current = cacheKey;
  getSerializedContentRef.current = () => {
    const cached = drawingContentCache.get(cacheKeyRef.current);
    return cached ? serializeExcalidraw(cached) : null;
  };

  // Initial data: prefer cache for instant mount, fall back to disk
  const initialData = drawingContentCache.get(cacheKey) ?? diskContent;

  // Seed version ref so the initial Excalidraw onChange (which fires with the
  // initial elements) doesn't trigger a spurious save of potentially stale data.
  if (lastVersionRef.current === 0 && initialData) {
    lastVersionRef.current = sceneVersion(initialData.elements);
  }

  // Conflict resolution: accept disk version
  const handleAcceptDisk = useCallback(() => {
    const data = hookAcceptDisk();
    if (!data) return;
    isProgrammaticRef.current = true;
    try {
      applyScene(excalidrawApiRef, data);
    } finally {
      isProgrammaticRef.current = false;
    }
    lastVersionRef.current = sceneVersion(data.elements);
  }, [hookAcceptDisk, isProgrammaticRef]);

  const handleChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      if (isProgrammaticRef.current || drawingTeardownActive) return;
      const version = sceneVersion(elements);
      if (version !== lastVersionRef.current) {
        lastVersionRef.current = version;
        hookHandleChange({ elements, appState, files });
      }
    },
    [hookHandleChange, isProgrammaticRef],
  );

  // Fix SVGLayer offset
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateViewBox = () => {
      const svg = container.querySelector<SVGSVGElement>(".SVGLayer svg");
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      svg.setAttribute("viewBox", `${rect.left} ${rect.top} ${rect.width} ${rect.height}`);
    };

    updateViewBox();
    const ro = new ResizeObserver(updateViewBox);
    ro.observe(container);
    window.addEventListener("resize", updateViewBox);
    const mo = new MutationObserver(updateViewBox);
    mo.observe(container, { childList: true, subtree: true });
    const interval = setInterval(updateViewBox, 500);

    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", updateViewBox);
      clearInterval(interval);
    };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function handleKeyDown(e: KeyboardEvent) {
      // Cmd+N and Cmd+W are handled by the global keybinding system (useKeybindings).
      if (e.metaKey && e.key === "s") {
        e.preventDefault();
        e.stopPropagation();
        saveNow();
      }
    }

    container.addEventListener("keydown", handleKeyDown, true);
    return () => container.removeEventListener("keydown", handleKeyDown, true);
  }, [saveNow]);

  // Sync external disk changes into the live editor when in clean state.
  // Dirty/saving/diverged states are handled by the conflict resolution flow.
  // Reads state live from the store (not the ref) because useEffect runs after paint,
  // and a keystroke between commit and effect can flip the state to "dirty" while the
  // render-time ref still reports "clean" — that would wipe the user's just-typed char.
  useEffect(() => {
    if (!diskContent || !excalidrawApiRef.current) return;
    if (useEditorStateStore.getState().files.get(filePath)?.state !== "clean") return;

    const diskVersion = sceneVersion(diskContent.elements);
    if (diskVersion === lastVersionRef.current) return;

    isProgrammaticRef.current = true;
    try {
      drawingContentCache.set(cacheKeyRef.current, diskContent);
      applyScene(excalidrawApiRef, diskContent);
      lastVersionRef.current = diskVersion;
    } finally {
      isProgrammaticRef.current = false;
    }
  }, [diskContent, isProgrammaticRef, filePath]);

  if (isError) {
    return (
      <div
        className="text-muted-foreground flex h-full items-center justify-center text-sm"
        style={{ backgroundColor: "var(--editor-surface)" }}
      >
        File not found
      </div>
    );
  }

  if (!initialData) {
    return (
      <div
        className="text-muted-foreground flex h-full items-center justify-center text-sm"
        style={{ backgroundColor: "var(--editor-surface)" }}
      >
        <div className="flex items-center gap-2">
          <div className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          Loading...
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex h-full w-full flex-col"
      style={{ backgroundColor: "var(--editor-surface)" }}
    >
      {editorFileState === "diverged" && (
        <ConflictBanner onAcceptDisk={handleAcceptDisk} onKeepMine={handleKeepMine} />
      )}
      <div className="flex-1">
        <Suspense
          fallback={
            <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
              <div className="flex items-center gap-2">
                <div className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Loading drawing editor...
              </div>
            </div>
          }
        >
          <ExcalidrawWithMenu
            excalidrawAPI={(api) => {
              excalidrawApiRef.current = api;
            }}
            initialData={{
              elements: initialData.elements,
              appState: initialData.appState,
              files: initialData.files,
            }}
            onChange={handleChange}
            theme={darkMode ? "dark" : "light"}
          />
        </Suspense>
      </div>
    </div>
  );
}
