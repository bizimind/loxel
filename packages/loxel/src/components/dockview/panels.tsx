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
import type { IDockviewPanelProps, IWatermarkPanelProps } from "dockview-react";
import type { LucideIcon } from "lucide-react";
import { AlertTriangleIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { AgentDevToolsPanel } from "@/components/agent-devtools/AgentDevToolsPanel";
import { BrowserPanel, type BrowserPanelParams } from "@/components/browser/BrowserPanel";
import { CodeEditorPanel } from "@/components/code-editor/CodeEditorPanel";
import { CodingAgentPanel } from "@/components/coding-agent/CodingAgentPanel";
import { ForkTreePanel } from "@/components/coding-agent/ForkTreePanel";
import { DiffViewerPanel } from "@/components/diff-viewer/DiffViewerPanel";
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
import { KeyComboDisplay } from "@/components/ui/key-combo-display";
import type { ActionId } from "@/store/keybindings/action-registry";
import { getBindingsForAction, useKeybindingStore } from "@/store/keybindings/keybinding-store";
import { CENTER_PANELS, QUICKSTART_PANELS, SIDEBAR_PANELS } from "@/store/panel-config";

import { AgentDevToolsTab } from "./agent-devtools-tab";
import { BrowserTab } from "./browser-tab";
import { CenterHostComponent } from "./CenterHost";
import { CodeEditorTab } from "./code-editor-tab";
import { CodingAgentTab } from "./coding-agent-tab";
import { DiffTab } from "./diff-tab";
import { ExcalidrawEditorTab } from "./excalidraw-editor-tab";
import { LocalDbTab } from "./localdb-tab";
import { MarkdownEditorTab } from "./markdown-editor-tab";
import { MediaTab } from "./media-tab";
import { PanelContext } from "./panel-context";
import { PanelErrorBoundary } from "./panel-error-boundary";
import { TerminalTab } from "./terminal-tab";

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

function DiffViewerComponent(_props: IDockviewPanelProps) {
  return <DiffViewerPanel />;
}

/** Terminal panel in the center group. */
function TerminalPanelComponent(
  props: IDockviewPanelProps<{ terminalId: string; worktreePath?: string }>,
) {
  return (
    <PanelContext.Provider value={{ worktreePath: props.params.worktreePath ?? null }}>
      <Terminal
        terminalId={props.params.terminalId}
        onClose={() => props.api.close()}
        onCreateNew={() => {
          window.dispatchEvent(new CustomEvent("loxel-create-terminal"));
        }}
        panelApi={props.api}
      />
    </PanelContext.Provider>
  );
}

/** Center watermark — visible when no center panels are open. */
export function CenterWatermark(_props: IWatermarkPanelProps) {
  return (
    <div className="bg-editor-surface flex h-full items-center justify-center">
      <div className="flex items-center gap-10">
        <img src="/watermark.svg" alt="" className="h-20 w-20 select-none" draggable={false} />

        <div className="flex flex-col gap-1.5">
          {QUICKSTART_PANELS.map((def) => (
            <QuickAction
              key={def.type}
              icon={<def.icon className="size-4" />}
              label={def.quickstartLabel}
              onClick={() => window.dispatchEvent(new CustomEvent(def.createEvent))}
              actionId={def.actionId ?? undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function QuickAction({
  icon,
  label,
  onClick,
  actionId,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  actionId?: ActionId;
}) {
  const store = useKeybindingStore();
  const combo = actionId ? getBindingsForAction(store, actionId)[0] : undefined;

  return (
    <button
      onClick={onClick}
      className="text-muted-foreground hover:text-foreground hover:bg-muted flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors"
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {combo && <KeyComboDisplay combo={combo} className="text-muted-foreground/60 ml-4 text-xs" />}
    </button>
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

function ForkTreePanelComponent(_props: IDockviewPanelProps) {
  return <ForkTreePanel />;
}

/** Standalone excalidraw drawing panel in the center group. */
function ExcalidrawPanelComponent(
  props: IDockviewPanelProps<{ filePath: string; worktreePath?: string }>,
) {
  return (
    <PanelContext.Provider value={{ worktreePath: props.params.worktreePath ?? null }}>
      <ExcalidrawEditor
        filePath={props.params.filePath}
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
  }>,
) {
  return (
    <PanelContext.Provider value={{ worktreePath: props.params.worktreePath ?? null }}>
      <CodeEditorPanel
        filePath={props.params.filePath}
        line={props.params.line}
        column={props.params.column}
        onClose={() => props.api.close()}
        panelApi={props.api}
      />
    </PanelContext.Provider>
  );
}

/** Browser panel in the center group. */
function BrowserPanelComponent(props: IDockviewPanelProps<BrowserPanelParams>) {
  return <BrowserPanel url={props.params.url} panelApi={props.api} />;
}

/** Coding agent panel in the center group. */
function CodingAgentPanelComponent(
  props: IDockviewPanelProps<{
    sessionId: string;
    worktreePath?: string;
    forkedSessionId?: string;
    forkPointMessageId?: string;
  }>,
) {
  return (
    <PanelContext.Provider value={{ worktreePath: props.params.worktreePath ?? null }}>
      <CodingAgentPanel
        sessionId={props.params.sessionId}
        forkedSessionId={props.params.forkedSessionId}
        forkPointMessageId={props.params.forkPointMessageId}
        panelApi={props.api}
      />
    </PanelContext.Provider>
  );
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

/** Agent DevTools panel in the center group. */
function AgentDevToolsPanelComponent(props: IDockviewPanelProps<{ sessionId: string }>) {
  return <AgentDevToolsPanel sessionId={props.params.sessionId} />;
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
    forkTree: ForkTreePanelComponent,
    centerHost: CenterHostComponent,
  },
  false,
);

/**
 * Center dockview components: editor/terminal/agent panels.
 * Wrapped with {@link PanelErrorBoundary} — center-styled error fallback.
 */
export const centerComponents = wrapPanelComponents(
  {
    diff: DiffViewerComponent,
    terminal: TerminalPanelComponent,
    editor: MarkdownEditorPanelComponent,
    excalidraw: ExcalidrawPanelComponent,
    codeEditor: CodeEditorPanelComponent,
    browser: BrowserPanelComponent,
    media: MediaViewerPanelComponent,
    codingAgent: CodingAgentPanelComponent,
    agentDevTools: AgentDevToolsPanelComponent,
    localDb: LocalDbPanelComponent,
  },
  true,
);

/** Custom tab components for center panels. */
export const centerTabComponents = {
  agentDevToolsTab: AgentDevToolsTab,
  browserTab: BrowserTab,
  codeEditorTab: CodeEditorTab,
  codingAgentTab: CodingAgentTab,
  diffTab: DiffTab,
  markdownEditorTab: MarkdownEditorTab,
  excalidrawEditorTab: ExcalidrawEditorTab,
  mediaTab: MediaTab,
  terminalTab: TerminalTab,
  localDbTab: LocalDbTab,
};
