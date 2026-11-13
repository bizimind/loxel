/**
 * Dockview panel component registries.
 *
 * Split into outer (sidebar + centerHost) and center (editor/terminal/etc.) registries
 * for the nested dockview architecture.
 *
 * Every panel component is automatically wrapped with a {@link PanelErrorBoundary}
 * via {@link wrapPanelComponents}. The error boundary catches render errors,
 * logs them to the frontend logger, and shows a per-panel fallback with
 * the panel's icon, error message, and a retry button.
 */
import type { IDockviewPanelProps } from "dockview-react";
import type { LucideIcon } from "lucide-react";
import { AlertTriangleIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { BrowserPanel, type BrowserPanelParams } from "@/components/browser/BrowserPanel";
import { CodeEditorPanel } from "@/components/code-editor/CodeEditorPanel";
import { VirtualDocumentPanel } from "@/components/code-editor/VirtualDocumentPanel";
import { CompareFilesPanel } from "@/components/compare/CompareFilesPanel";
import { DiffViewerPanel, type DiffViewerSource } from "@/components/diff-viewer/DiffViewerPanel";
import { MarkdownEditorPanelComponent } from "@/components/editor/MarkdownEditorPanel";
import { ExcalidrawEditor } from "@/components/excalidraw-editor/ExcalidrawEditor";
import { GraphPanel } from "@/components/graph/GraphPanel";
import { LocalDbPanel } from "@/components/localdb/LocalDbPanel";
import { MediaViewerPanel } from "@/components/media-viewer/MediaViewerPanel";
import { CommentsPanel } from "@/components/panels/CommentsPanel";
import { FileTreePanel } from "@/components/panels/FileTreePanel";
import { LogsPanel } from "@/components/panels/LogsPanel";
import { ProjectFilesPanel } from "@/components/panels/ProjectFilesPanel";
import { Terminal } from "@/components/terminal/Terminal";
import type { PatchDiffParams } from "@/lib/panel-creators";
import { CENTER_PANELS, SIDEBAR_PANELS } from "@/store/panel-config";

import { BrowserTab } from "./browser-tab";
import { CenterHostComponent } from "./CenterHost";
import { CodeEditorTab } from "./code-editor-tab";
import { CompareTab } from "./compare-tab";
import { DiffTab, PatchDiffTab } from "./diff-tab";
import { ExcalidrawEditorTab } from "./excalidraw-editor-tab";
import { LocalDbTab } from "./localdb-tab";
import { MarkdownEditorTab } from "./markdown-editor-tab";
import { MediaTab } from "./media-tab";
import { PanelContext } from "./panel-context";
import { PanelErrorBoundary } from "./panel-error-boundary";
import { TerminalTab } from "./terminal-tab";
import { VirtualDocumentTab } from "./virtual-document-tab";

// ---------------------------------------------------------------------------
// Icon map — derived from the panel registries so the error boundary fallback
// can show the panel's own icon. Falls back to AlertTriangleIcon for unknown panels.
// ---------------------------------------------------------------------------

const panelIconMap = new Map<string, LucideIcon>([
  ...SIDEBAR_PANELS.map((def) => [def.id, def.icon] as const),
  ...CENTER_PANELS.map((def) => [def.component, def.icon] as const),
]);

function getPanelIcon(componentName: string): LucideIcon {
  return panelIconMap.get(componentName) ?? AlertTriangleIcon;
}

// ---------------------------------------------------------------------------
// Wrapping — wraps every raw panel component with a PanelErrorBoundary and
// the standard layout div so individual panels never need to think about it.
// ---------------------------------------------------------------------------

function wrapPanelComponents(
  raw: Record<string, React.FunctionComponent<IDockviewPanelProps>>,
  center: boolean,
): Record<string, React.FunctionComponent<IDockviewPanelProps>> {
  const wrapped: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {};
  for (const [name, Component] of Object.entries(raw)) {
    const Icon = getPanelIcon(name);
    wrapped[name] = (props: IDockviewPanelProps) => (
      <PanelErrorBoundary panelName={name} Icon={Icon} center={center}>
        <div className="flex h-full w-full flex-col overflow-hidden">
          <Component {...props} />
        </div>
      </PanelErrorBoundary>
    );
  }
  return wrapped;
}

// ---------------------------------------------------------------------------
// Raw panel components — no wrapper needed, wrapPanelComponents adds it.
// ---------------------------------------------------------------------------

function FileTreePanelComponent(props: IDockviewPanelProps) {
  return <FileTreePanel panelApi={props.api} />;
}

function ProjectFilesPanelComponent(_props: IDockviewPanelProps) {
  return <ProjectFilesPanel />;
}

function GraphPanelComponent(_props: IDockviewPanelProps) {
  return <GraphPanel />;
}

const GIT_DIFF_SOURCE: DiffViewerSource = { type: "git" };

function DiffViewerComponent(_props: IDockviewPanelProps) {
  return <DiffViewerPanel source={GIT_DIFF_SOURCE} />;
}

/** A patch's diff, such as a markdown diff fence's, from the text captured when it opened. */
function PatchDiffComponent(props: IDockviewPanelProps<PatchDiffParams>) {
  const { patch, sourcePath } = props.params;
  const source = useMemo<DiffViewerSource>(
    () => ({ type: "patch", patch, sourcePath }),
    [patch, sourcePath],
  );
  return <DiffViewerPanel source={source} />;
}

/** Two files compared side by side, both editable. */
function CompareFilesPanelComponent(
  props: IDockviewPanelProps<{ oldPath: string; newPath: string; worktreePath?: string }>,
) {
  return (
    <PanelContext.Provider value={{ worktreePath: props.params.worktreePath ?? null }}>
      <CompareFilesPanel
        panelId={props.api.id}
        oldPath={props.params.oldPath}
        newPath={props.params.newPath}
      />
    </PanelContext.Provider>
  );
}

/** Terminal panel in the center group. `cwd` is set only when the shell starts outside the worktree. */
function TerminalPanelComponent(
  props: IDockviewPanelProps<{ terminalId: string; worktreePath?: string; cwd?: string }>,
) {
  return (
    <PanelContext.Provider value={{ worktreePath: props.params.worktreePath ?? null }}>
      <Terminal
        terminalId={props.params.terminalId}
        cwd={props.params.cwd}
        onClose={() => props.api.close()}
        onCreateNew={() => {
          window.dispatchEvent(new CustomEvent("loxel-create-terminal"));
        }}
        panelApi={props.api}
      />
    </PanelContext.Provider>
  );
}

function CommentsPanelComponent(_props: IDockviewPanelProps) {
  return <CommentsPanel />;
}

/**
 * LogsPanel is mount-gated on panel visibility so dockview only instantiates
 * it when its tab is active. This avoids keeping a 5000-row virtualized list
 * in the React tree (and streaming logs into it) when the panel isn't shown.
 * State persists in `useLogStore`, so remounting is cheap.
 */
function LogsPanelComponent(props: IDockviewPanelProps) {
  const [visible, setVisible] = useState(() => props.api.isVisible);

  useEffect(() => {
    const disposable = props.api.onDidVisibilityChange((e) => setVisible(e.isVisible));
    return () => disposable.dispose();
  }, [props.api]);

  if (!visible) return null;
  return <LogsPanel />;
}

/** Standalone excalidraw drawing panel in the center group. */
function ExcalidrawPanelComponent(
  props: IDockviewPanelProps<{ filePath: string; worktreePath?: string; movedFrom?: string }>,
) {
  return (
    <PanelContext.Provider value={{ worktreePath: props.params.worktreePath ?? null }}>
      <ExcalidrawEditor
        filePath={props.params.filePath}
        movedFrom={props.params.movedFrom}
        onClose={() => props.api.close()}
        onCreateNew={() => {
          window.dispatchEvent(new CustomEvent("loxel-create-drawing"));
        }}
        panelApi={props.api}
      />
    </PanelContext.Provider>
  );
}

/** Standalone code editor panel in the center group. */
function CodeEditorPanelComponent(
  props: IDockviewPanelProps<{
    filePath: string;
    worktreePath?: string;
    line?: number;
    column?: number;
    movedFrom?: string;
  }>,
) {
  return (
    <PanelContext.Provider value={{ worktreePath: props.params.worktreePath ?? null }}>
      <CodeEditorPanel
        filePath={props.params.filePath}
        line={props.params.line}
        column={props.params.column}
        movedFrom={props.params.movedFrom}
        onClose={() => props.api.close()}
        panelApi={props.api}
      />
    </PanelContext.Provider>
  );
}

/** A language server's read-only document in the center group. */
function VirtualDocumentPanelComponent(
  props: IDockviewPanelProps<{ uri: string; connectionId: string; line?: number; column?: number }>,
) {
  return (
    <VirtualDocumentPanel
      uri={props.params.uri}
      connectionId={props.params.connectionId}
      line={props.params.line}
      column={props.params.column}
      panelApi={props.api}
    />
  );
}

/** Browser panel in the center group. */
function BrowserPanelComponent(props: IDockviewPanelProps<BrowserPanelParams>) {
  return <BrowserPanel url={props.params.url} panelApi={props.api} />;
}

/** Media viewer panel in the center group. */
function MediaViewerPanelComponent(
  props: IDockviewPanelProps<{ filePath: string; worktreePath?: string }>,
) {
  return (
    <PanelContext.Provider value={{ worktreePath: props.params.worktreePath ?? null }}>
      <MediaViewerPanel filePath={props.params.filePath} panelApi={props.api} />
    </PanelContext.Provider>
  );
}

function LocalDbPanelComponent(_props: IDockviewPanelProps) {
  return <LocalDbPanel />;
}

/**
 * Outer dockview components: sidebar panels + the center host.
 * Wrapped with {@link PanelErrorBoundary} — sidebar-styled error fallback.
 */
export const outerComponents = wrapPanelComponents(
  {
    changes: FileTreePanelComponent,
    projectFiles: ProjectFilesPanelComponent,
    git: GraphPanelComponent,
    comments: CommentsPanelComponent,
    logs: LogsPanelComponent,
    centerHost: CenterHostComponent,
  },
  false,
);

/**
 * Center dockview components: editor/terminal panels.
 * Wrapped with {@link PanelErrorBoundary} — center-styled error fallback.
 */
export const centerComponents = wrapPanelComponents(
  {
    diff: DiffViewerComponent,
    patchDiff: PatchDiffComponent,
    compare: CompareFilesPanelComponent,
    terminal: TerminalPanelComponent,
    editor: MarkdownEditorPanelComponent,
    excalidraw: ExcalidrawPanelComponent,
    codeEditor: CodeEditorPanelComponent,
    virtualDocument: VirtualDocumentPanelComponent,
    browser: BrowserPanelComponent,
    media: MediaViewerPanelComponent,
    localDb: LocalDbPanelComponent,
  },
  true,
);

/** Custom tab components for center panels. */
export const centerTabComponents = {
  browserTab: BrowserTab,
  codeEditorTab: CodeEditorTab,
  compareTab: CompareTab,
  diffTab: DiffTab,
  patchDiffTab: PatchDiffTab,
  markdownEditorTab: MarkdownEditorTab,
  excalidrawEditorTab: ExcalidrawEditorTab,
  mediaTab: MediaTab,
  terminalTab: TerminalTab,
  localDbTab: LocalDbTab,
  virtualDocumentTab: VirtualDocumentTab,
};

/** Dockview components (content or tab) of the center panels that need no worktree. */
function withoutWorktreePanels<T>(registry: Record<string, T>, key: "component" | "tabComponent") {
  const keys = new Set<string>(
    CENTER_PANELS.filter((def) => !def.needsWorktree).map((def) => def[key]),
  );
  return Object.fromEntries(Object.entries(registry).filter(([name]) => keys.has(name)));
}

/** Home's center components: only panels that need no worktree. */
export const homeComponents = withoutWorktreePanels(centerComponents, "component");

/** Tabs of Home's center panels. */
export const homeTabComponents = withoutWorktreePanels(centerTabComponents, "tabComponent");
