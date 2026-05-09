import type { editor as monacoEditor } from "monaco-editor";

import { useQuery } from "@tanstack/react-query";
import * as monaco from "monaco-editor";
import { useEffect, useMemo, useRef } from "react";

import * as api from "@/api/client";
import { ProjectIcon } from "@/components/projects/ProjectIcon";
import { getMonacoThemeName } from "@/lib/monaco-theme";
import { cn } from "@/lib/utils";
import { deriveProject, useProjectStore } from "@/store/projects";
import { useSettingsStore } from "@/store/settings-store";
import { useUIStore } from "@/store/ui";
import { type ProjectState, useWorktreeStore } from "@/store/worktrees";

type IStandaloneCodeEditor = monacoEditor.IStandaloneCodeEditor;

/** URI used for the wt.yaml model — matched by yaml-language-server schema config. */
const WT_YAML_MODEL_URI = "file:///wt.yaml";

export function WorktreesSection() {
  const projects = useProjectStore((s) => s.projects);
  const activeWorktreePath = useWorktreeStore((s) => s.activeWorktreePath);
  const activeProjectId = useProjectStore(
    (s) => deriveProject(activeWorktreePath, s.projects)?.id ?? null,
  );

  const selectedProjectId = useSettingsStore((s) => s.wtConfigSelectedProjectId);
  const setSelectedProject = useSettingsStore((s) => s.setWtConfigSelectedProject);

  const darkMode = useUIStore((s) => s.darkMode);

  // Read wt config status from the worktree store (populated by GET /api/projects enriched data)
  const byProject = useWorktreeStore((s) => s.byProject);

  /** Lookup hasWtConfig for a project by id (uses project path to index into worktree store). */
  const getProjectConfig = useMemo(() => {
    const pathById = new Map(projects.map((p) => [p.id, p.path]));
    return (projectId: string): ProjectState | undefined => {
      const path = pathById.get(projectId);
      return path ? byProject[path] : undefined;
    };
  }, [projects, byProject]);

  // Auto-select first project with wt config
  useEffect(() => {
    if (selectedProjectId) return;
    if (projects.length === 0) return;

    // Prefer active project if it has wt config
    if (activeProjectId && getProjectConfig(activeProjectId)?.hasWtConfig) {
      setSelectedProject(activeProjectId);
      return;
    }

    // Otherwise first project with wt config
    for (const project of projects) {
      if (getProjectConfig(project.id)?.hasWtConfig) {
        setSelectedProject(project.id);
        return;
      }
    }
  }, [getProjectConfig, activeProjectId, projects, selectedProjectId, setSelectedProject]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId),
    [projects, selectedProjectId],
  );

  const hasWtConfig = selectedProjectId
    ? (getProjectConfig(selectedProjectId)?.hasWtConfig ?? false)
    : false;

  // Check if any project has wt config
  const anyProjectHasWt = useMemo(
    () => projects.some((p) => getProjectConfig(p.id)?.hasWtConfig),
    [projects, getProjectConfig],
  );

  return (
    <div>
      <h3 className="text-foreground mb-1 text-sm font-semibold">Worktrees</h3>
      <p className="text-muted-foreground mb-4 text-xs">
        Edit wt.yaml configuration for your projects.
      </p>

      {!anyProjectHasWt ? (
        <div className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-xs">
          No projects have a wt.yaml configuration file.
        </div>
      ) : (
        <div
          className="border-border flex overflow-hidden rounded-md border"
          style={{ height: 380 }}
        >
          {/* Mini project sidebar */}
          <div className="border-border flex w-[140px] shrink-0 flex-col overflow-y-auto border-r">
            {projects.map((project) => {
              const hasConfig = getProjectConfig(project.id)?.hasWtConfig ?? false;
              const isSelected = project.id === selectedProjectId;

              return (
                <button
                  key={project.id}
                  disabled={!hasConfig}
                  onClick={() => hasConfig && setSelectedProject(project.id)}
                  className={cn(
                    "flex items-center gap-2 px-2.5 py-2 text-left text-xs transition-colors",
                    hasConfig ? "hover:bg-muted/50 cursor-pointer" : "cursor-default opacity-40",
                    isSelected && hasConfig && "bg-primary",
                  )}
                >
                  <ProjectIcon id={project.id} name={project.name} size="xs" />
                  <span className="text-foreground min-w-0 truncate">{project.name}</span>
                </button>
              );
            })}
          </div>

          {/* Editor area */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {selectedProject && hasWtConfig ? (
              <WtConfigEditor
                projectId={selectedProject.id}
                projectName={selectedProject.name}
                darkMode={darkMode}
              />
            ) : (
              <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
                Select a project to edit its wt.yaml
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Monaco editor sub-component ---

interface WtConfigEditorProps {
  projectId: string;
  projectName: string;
  darkMode: boolean;
}

function WtConfigEditor({ projectId, projectName, darkMode }: WtConfigEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<IStandaloneCodeEditor | null>(null);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const setEditorContent = useSettingsStore((s) => s.setWtConfigEditorContent);
  const setOriginalContent = useSettingsStore((s) => s.setWtConfigOriginalContent);
  const setHasErrors = useSettingsStore((s) => s.setWtConfigHasErrors);

  // Fetch wt.yaml content from server
  const { data: configData } = useQuery({
    queryKey: ["wt-config-raw", projectId],
    queryFn: () => api.getWtConfigRaw(projectId),
  });

  const serverContent = configData?.content ?? "";

  // Check if there's already a stored edit for this project (from a previous switch)
  const storedEdit = useSettingsStore((s) => s.wtConfigEditorContents[projectId]);

  // Mount editor when server content is available.
  // If the user previously edited this project, restore that content instead.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || configData === undefined) return;

    // Record the original (server) content for dirty comparison
    setOriginalContent(projectId, serverContent);

    // Use stored edit if available, otherwise server content
    const displayContent = storedEdit ?? serverContent;

    const uri = monaco.Uri.parse(WT_YAML_MODEL_URI);
    let model = monaco.editor.getModel(uri);
    if (model) {
      if (model.getValue() !== displayContent) model.setValue(displayContent);
    } else {
      model = monaco.editor.createModel(displayContent, "yaml", uri);
    }

    const editor = monaco.editor.create(container, {
      model,
      theme: getMonacoThemeName(darkMode),
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineHeight: 22,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
      automaticLayout: true,
      contextmenu: false,
      lineNumbers: "on",
      folding: true,
      fixedOverflowWidgets: true,
      stickyScroll: { enabled: false },
      renderLineHighlight: "line",
      scrollbar: { vertical: "auto", horizontal: "auto" },
      padding: { top: 4 },
      tabSize: 2,
    });

    editorRef.current = editor;

    // Track content changes — store per project
    const contentDisposable = editor.onDidChangeModelContent(() => {
      const currentValue = editor.getModel()?.getValue() ?? "";
      const pid = projectIdRef.current;
      setEditorContent(pid, currentValue);
    });

    // Track marker changes for validation
    const markerDisposable = monaco.editor.onDidChangeMarkers((changedUris) => {
      const matches = changedUris.some((u) => u.toString() === uri.toString());
      if (!matches) return;
      const markers = monaco.editor.getModelMarkers({ resource: uri });
      const hasErrors = markers.some((m) => m.severity === monaco.MarkerSeverity.Error);
      const pid = projectIdRef.current;
      setHasErrors(pid, hasErrors);
    });

    return () => {
      contentDisposable.dispose();
      markerDisposable.dispose();
      editorRef.current = null;
      const editorModel = editor.getModel();
      editor.dispose();
      editorModel?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, configData, darkMode]);

  return (
    <>
      <div className="border-border text-muted-foreground flex shrink-0 items-center gap-1.5 border-b px-3 py-1.5 text-[11px]">
        <span className="opacity-60">wt.yaml</span>
        <span className="opacity-40">&mdash;</span>
        <span>{projectName}</span>
      </div>
      <div ref={containerRef} className="flex-1" />
    </>
  );
}
