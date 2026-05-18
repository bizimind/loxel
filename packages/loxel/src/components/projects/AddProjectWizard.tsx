import {
  AlertTriangleIcon,
  FolderIcon,
  GitBranchIcon,
  GlobeIcon,
  InfoIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "@/api/client";
import type { DetectPathResult, WorkspaceSetup } from "@/api/project-model";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/store/projects";

import { FolderPickerContent } from "./FolderPicker";
import { looksLikeGitUrl, repoNameFromUrl } from "./wizard-detection";
import { type WorkspaceConfig, WorkspaceConfigStep } from "./WorkspaceConfigStep";

type WizardTab = "new" | "import";

type ImportStep =
  | "select-source"
  | "detected-repo"
  | "detected-url"
  | "detected-non-repo"
  | "detected-not-found"
  | "workspace-config";

type NewStep = "form" | "workspace-config";

interface AddProjectWizardProps {
  open: boolean;
  onClose: () => void;
}

export function AddProjectWizard({ open, onClose }: AddProjectWizardProps) {
  const [tab, setTab] = useState<WizardTab>("new");
  const fetchProjects = useProjectStore((s) => s.fetchProjects);

  // --- New project state ---
  const [newName, setNewName] = useState("");
  const [newLocation, setNewLocation] = useState("~/projects");
  const [newSetup, setNewSetup] = useState<WorkspaceSetup>("multi");
  const [newStep, setNewStep] = useState<NewStep>("form");
  const [newConfig, setNewConfig] = useState<WorkspaceConfig>({ copyFiles: [], setupCommands: [] });

  // --- Import state ---
  const [importStep, setImportStep] = useState<ImportStep>("select-source");
  const [importInput, setImportInput] = useState("");
  const [detection, setDetection] = useState<DetectPathResult | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [importName, setImportName] = useState("");
  const [importSetup, setImportSetup] = useState<WorkspaceSetup>("multi");
  const [cloneDestination, setCloneDestination] = useState("~/git");
  const [importConfig, setImportConfig] = useState<WorkspaceConfig>({
    copyFiles: [],
    setupCommands: [],
  });
  // --- Shared state ---
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showLocationPicker, setShowLocationPicker] = useState(false);
  const [locationPickerTarget, setLocationPickerTarget] = useState<"new" | "clone" | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  // Reset on open/close
  useEffect(() => {
    if (open) {
      setTab("import");
      setNewStep("form");
      setNewName("");
      setNewSetup("multi");
      setNewConfig({ copyFiles: [], setupCommands: [] });
      setImportStep("select-source");
      setImportInput("");
      setDetection(null);
      setImportName("");
      setImportSetup("multi");
      setImportConfig({ copyFiles: [], setupCommands: [] });
      setSubmitting(false);
      setErrorMsg(null);
      setShowLocationPicker(false);
      setNewLocation("~/projects");
      setCloneDestination("~/git");
    }
  }, [open]);

  const handleClose = useCallback(() => {
    if (!submitting) onClose();
  }, [onClose, submitting]);

  // --- Detection ---
  const runDetection = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    if (looksLikeGitUrl(trimmed)) {
      const name = repoNameFromUrl(trimmed);
      setDetection({ type: "git-url", path: trimmed, name });
      setImportName(name);
      setImportStep("detected-url");
      return;
    }

    setDetecting(true);
    setErrorMsg(null);
    try {
      const result = await api.detectPath(trimmed);
      setDetection(result);
      setImportName(result.name);

      switch (result.type) {
        case "git-repo-bare":
        case "git-repo-regular":
          setImportStep("detected-repo");
          setImportSetup("single");
          break;
        case "git-url":
          setImportStep("detected-url");
          break;
        case "non-repo-folder":
          setImportStep("detected-non-repo");
          break;
        case "path-not-found":
          setImportStep("detected-not-found");
          break;
        case "invalid":
        default:
          setImportStep("select-source");
          setErrorMsg("Enter a local path or git URL");
          break;
      }
    } catch {
      setErrorMsg("Failed to detect path");
    } finally {
      setDetecting(false);
    }
  }, []);

  const handleImportInputSubmit = useCallback(() => {
    runDetection(importInput);
  }, [importInput, runDetection]);

  const handleBrowseSelect = useCallback(
    (path: string) => {
      setImportInput(path);
      runDetection(path);
    },
    [runDetection],
  );

  // --- Actions ---
  const handleAddAsIs = useCallback(async () => {
    if (!detection) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await api.addProject(detection.path, importName || undefined);
      await fetchProjects();
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to add project");
    } finally {
      setSubmitting(false);
    }
  }, [detection, importName, fetchProjects, onClose]);

  const handleCreateNew = useCallback(async () => {
    if (!newName.trim()) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await api.createProject({
        name: newName.trim(),
        location: newLocation,
        setup: newSetup,
        copyFiles: newConfig.copyFiles,
        setupCommands: newConfig.setupCommands,
      });
      await fetchProjects();
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setSubmitting(false);
    }
  }, [newName, newLocation, newSetup, newConfig, fetchProjects, onClose]);

  const handleClone = useCallback(async () => {
    if (!detection) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await api.cloneProject({
        url: detection.path,
        destination: cloneDestination,
        setup: importSetup,
        copyFiles: importConfig.copyFiles,
        setupCommands: importConfig.setupCommands,
      });
      await fetchProjects();
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to clone");
    } finally {
      setSubmitting(false);
    }
  }, [detection, cloneDestination, importSetup, importConfig, fetchProjects, onClose]);

  const handleInit = useCallback(async () => {
    if (!detection) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await api.initProject({
        path: detection.path,
        name: importName || undefined,
        setup: importSetup,
        copyFiles: importConfig.copyFiles,
        setupCommands: importConfig.setupCommands,
      });
      await fetchProjects();
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to initialize");
    } finally {
      setSubmitting(false);
    }
  }, [detection, importName, importSetup, importConfig, fetchProjects, onClose]);

  const handleConvert = useCallback(async () => {
    if (!detection) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await api.convertProject({
        path: detection.path,
        copyFiles: importConfig.copyFiles,
        setupCommands: importConfig.setupCommands,
      });
      await fetchProjects();
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to convert");
    } finally {
      setSubmitting(false);
    }
  }, [detection, importConfig, fetchProjects, onClose]);

  // --- Location picker overlay ---
  if (showLocationPicker) {
    return (
      <DialogShell open={open} onCancel={handleClose} className="h-[520px] w-[560px]">
        <div className="flex h-full flex-col">
          <div className="border-border flex items-center justify-between border-b px-5 py-3">
            <h3 className="text-foreground text-sm font-medium">Choose location</h3>
            <button
              onClick={() => setShowLocationPicker(false)}
              className="text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <XCircleIcon className="size-4" />
            </button>
          </div>
          <FolderPickerContent
            onSelect={(path) => {
              if (locationPickerTarget === "new") setNewLocation(path);
              else if (locationPickerTarget === "clone") setCloneDestination(path);
              setShowLocationPicker(false);
            }}
            allowNonGitFolders
          />
        </div>
      </DialogShell>
    );
  }

  return (
    <DialogShell open={open} onCancel={handleClose} className="h-[520px] w-[560px]">
      <div className="flex h-full flex-col">
        {/* Header with tabs */}
        <div className="border-border border-b px-5 py-3">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-foreground text-sm font-medium">Add Project</h3>
            <button
              onClick={handleClose}
              className="text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <XCircleIcon className="size-4" />
            </button>
          </div>
          <div className="bg-muted flex rounded-md p-0.5">
            <button
              onClick={() => {
                setTab("new");
                setErrorMsg(null);
              }}
              className={cn(
                "flex-1 rounded-sm px-3 py-1.5 text-xs font-medium transition-colors",
                tab === "new"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground cursor-pointer",
              )}
            >
              New Project
            </button>
            <button
              onClick={() => {
                setTab("import");
                setErrorMsg(null);
              }}
              className={cn(
                "flex-1 rounded-sm px-3 py-1.5 text-xs font-medium transition-colors",
                tab === "import"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground cursor-pointer",
              )}
            >
              Import Existing
            </button>
          </div>
        </div>

        {/* Error banner */}
        {errorMsg && (
          <div className="bg-destructive/10 text-destructive border-destructive/20 border-b px-5 py-2 text-xs">
            {errorMsg}
          </div>
        )}

        {/* Content */}
        {tab === "new" ? (
          newStep === "workspace-config" ? (
            <WorkspaceConfigStep
              scanPath={null}
              config={newConfig}
              onChange={setNewConfig}
              onBack={() => setNewStep("form")}
              onSubmit={handleCreateNew}
              submitLabel="Create"
              submitting={submitting}
            />
          ) : (
            <NewProjectForm
              name={newName}
              onNameChange={setNewName}
              location={newLocation}
              onBrowseLocation={() => {
                setLocationPickerTarget("new");
                setShowLocationPicker(true);
              }}
              setup={newSetup}
              onSetupChange={setNewSetup}
              onSubmit={
                newSetup === "multi" ? () => setNewStep("workspace-config") : handleCreateNew
              }
              onCancel={handleClose}
              submitting={submitting}
              isMulti={newSetup === "multi"}
            />
          )
        ) : importStep === "workspace-config" ? (
          <WorkspaceConfigStep
            scanPath={detection?.type === "git-url" ? null : (detection?.path ?? null)}
            config={importConfig}
            onChange={setImportConfig}
            onBack={() => {
              if (detection?.type === "git-url") setImportStep("detected-url");
              else if (detection?.type === "non-repo-folder") setImportStep("detected-non-repo");
              else setImportStep("detected-repo");
            }}
            onSubmit={
              detection?.type === "git-repo-regular"
                ? handleConvert
                : detection?.type === "git-url"
                  ? handleClone
                  : handleInit
            }
            submitLabel={
              detection?.type === "git-repo-regular"
                ? "Convert"
                : detection?.type === "git-url"
                  ? "Clone"
                  : "Initialize"
            }
            submitting={submitting}
          />
        ) : (
          <ImportFlow
            step={importStep}
            input={importInput}
            onInputChange={setImportInput}
            onInputSubmit={handleImportInputSubmit}
            onBrowseSelect={handleBrowseSelect}
            inputRef={inputRef}
            detecting={detecting}
            detection={detection}
            importName={importName}
            onNameChange={setImportName}
            importSetup={importSetup}
            onSetupChange={setImportSetup}
            cloneDestination={cloneDestination}
            onBrowseCloneDestination={() => {
              setLocationPickerTarget("clone");
              setShowLocationPicker(true);
            }}
            onAddAsIs={handleAddAsIs}
            onNextConfig={() => setImportStep("workspace-config")}
            onClone={
              importSetup === "multi" ? () => setImportStep("workspace-config") : handleClone
            }
            onInit={importSetup === "multi" ? () => setImportStep("workspace-config") : handleInit}
            onSwitchToNew={() => setTab("new")}
            onReset={() => {
              setImportStep("select-source");
              setImportInput("");
              setDetection(null);
              setErrorMsg(null);
            }}
            onCancel={handleClose}
            submitting={submitting}
          />
        )}
      </div>
    </DialogShell>
  );
}

// --- Sub-components ---

function NewProjectForm({
  name,
  onNameChange,
  location,
  onBrowseLocation,
  setup,
  onSetupChange,
  onSubmit,
  onCancel,
  submitting,
  isMulti,
}: {
  name: string;
  onNameChange: (v: string) => void;
  location: string;
  onBrowseLocation: () => void;
  setup: WorkspaceSetup;
  onSetupChange: (v: WorkspaceSetup) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitting: boolean;
  isMulti: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <FieldGroup label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="my-awesome-app"
            className="bg-input/30 border-border text-foreground placeholder:text-muted-foreground focus:border-ring h-8 w-full rounded-md border px-3 text-xs outline-none"
            autoFocus
          />
        </FieldGroup>

        <FieldGroup label="Location">
          <div className="flex gap-1.5">
            <input
              type="text"
              value={location}
              readOnly
              className="bg-input/30 border-border text-foreground h-8 flex-1 rounded-md border px-3 text-xs outline-none"
            />
            <Button variant="outline" size="sm" onClick={onBrowseLocation}>
              Browse
            </Button>
          </div>
        </FieldGroup>

        <FieldGroup label="Workspace setup">
          <WorkspaceSetupPicker value={setup} onChange={onSetupChange} />
        </FieldGroup>
      </div>

      <div className="border-border flex items-center justify-end gap-2 border-t px-5 py-3">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={onSubmit} disabled={!name.trim() || submitting}>
          {submitting ? "Creating..." : isMulti ? "Next" : "Create"}
        </Button>
      </div>
    </div>
  );
}

function ImportFlow({
  step,
  input,
  onInputChange,
  onInputSubmit,
  onBrowseSelect,
  inputRef,
  detecting,
  detection,
  importName,
  onNameChange,
  importSetup,
  onSetupChange,
  cloneDestination,
  onBrowseCloneDestination,
  onAddAsIs,
  onNextConfig,
  onClone,
  onInit,
  onSwitchToNew,
  onReset,
  onCancel,
  submitting,
}: {
  step: ImportStep;
  input: string;
  onInputChange: (v: string) => void;
  onInputSubmit: () => void;
  onBrowseSelect: (path: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  detecting: boolean;
  detection: DetectPathResult | null;
  importName: string;
  onNameChange: (v: string) => void;
  importSetup: WorkspaceSetup;
  onSetupChange: (v: WorkspaceSetup) => void;
  cloneDestination: string;
  onBrowseCloneDestination: () => void;
  onAddAsIs: () => void;
  onNextConfig: () => void;
  onClone: () => void;
  onInit: () => void;
  onSwitchToNew: () => void;
  onReset: () => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  if (step === "select-source") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Input bar */}
        <div className="border-border space-y-2 border-b px-5 py-3">
          <FieldGroup label="Path or git URL">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onInputSubmit();
              }}
              className="flex gap-1.5"
            >
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                placeholder="~/projects/my-app or https://github.com/..."
                className="bg-input/30 border-border text-foreground placeholder:text-muted-foreground focus:border-ring h-8 flex-1 rounded-md border px-3 text-xs outline-none"
                autoFocus
              />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={!input.trim() || detecting}
              >
                {detecting ? "..." : "Go"}
              </Button>
            </form>
          </FieldGroup>
          <p className="text-muted-foreground text-[11px]">Or browse for a folder below</p>
        </div>

        {/* Inline folder picker */}
        <FolderPickerContent onSelect={onBrowseSelect} allowNonGitFolders />
      </div>
    );
  }

  // All other steps show the detection result
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Path display with change button */}
      <div className="border-border flex items-center gap-2 border-b px-5 py-2.5">
        <SourceIcon type={detection?.type} />
        <span className="text-foreground flex-1 truncate text-xs font-medium">
          {input || detection?.path}
        </span>
        <Button variant="ghost" size="xs" onClick={onReset}>
          Change
        </Button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {step === "detected-repo" && detection && (
          <DetectedRepoPanel
            detection={detection}
            name={importName}
            onNameChange={onNameChange}
            setup={importSetup}
            onSetupChange={onSetupChange}
          />
        )}

        {step === "detected-url" && (
          <DetectedUrlPanel
            setup={importSetup}
            onSetupChange={onSetupChange}
            cloneDestination={cloneDestination}
            onBrowseDestination={onBrowseCloneDestination}
          />
        )}

        {step === "detected-non-repo" && (
          <DetectedNonRepoPanel
            name={importName}
            onNameChange={onNameChange}
            setup={importSetup}
            onSetupChange={onSetupChange}
          />
        )}

        {step === "detected-not-found" && (
          <div className="space-y-3">
            <StatusLine icon="error" text="Path does not exist" />
            <p className="text-muted-foreground text-xs">
              Did you mean to create a new project?{" "}
              <button
                onClick={onSwitchToNew}
                className="text-primary cursor-pointer underline underline-offset-2"
              >
                Switch to New Project
              </button>
            </p>
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="border-border flex items-center justify-end gap-2 border-t px-5 py-3">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        {step === "detected-repo" && importSetup === "single" && (
          <Button size="sm" onClick={onAddAsIs} disabled={submitting}>
            {submitting ? "Adding..." : "Add"}
          </Button>
        )}
        {step === "detected-repo" && importSetup === "multi" && (
          <Button size="sm" onClick={onNextConfig} disabled={detection?.hasUncommittedChanges}>
            Next
          </Button>
        )}
        {step === "detected-url" && (
          <Button size="sm" onClick={onClone} disabled={submitting}>
            {submitting ? "Cloning..." : importSetup === "multi" ? "Next" : "Clone"}
          </Button>
        )}
        {step === "detected-non-repo" && (
          <Button size="sm" onClick={onInit} disabled={submitting}>
            {submitting ? "Initializing..." : importSetup === "multi" ? "Next" : "Initialize"}
          </Button>
        )}
      </div>
    </div>
  );
}

function DetectedRepoPanel({
  detection,
  name,
  onNameChange,
  setup,
  onSetupChange,
}: {
  detection: DetectPathResult;
  name: string;
  onNameChange: (v: string) => void;
  setup: WorkspaceSetup;
  onSetupChange: (v: WorkspaceSetup) => void;
}) {
  const isBare = detection.type === "git-repo-bare";
  const label = isBare ? "bare" : "regular";

  return (
    <div className="space-y-4">
      <StatusLine
        icon="success"
        text={`Git repository · ${label}${detection.branch ? ` · ${detection.branch}` : ""}`}
      />

      <FieldGroup label="Name">
        <input
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          className="bg-input/30 border-border text-foreground focus:border-ring h-8 w-full rounded-md border px-3 text-xs outline-none"
        />
      </FieldGroup>

      {!isBare && !detection.hasWtConfig && (
        <div className="space-y-2">
          <FieldGroup label="Workspace setup">
            <WorkspaceSetupPicker value={setup} onChange={onSetupChange} />
          </FieldGroup>

          {setup === "multi" && detection.hasUncommittedChanges && (
            <div className="flex items-start gap-1.5">
              <AlertTriangleIcon className="text-warning mt-0.5 size-3.5 shrink-0" />
              <p className="text-warning text-[11px]">
                Uncommitted changes detected. Commit or stash changes before converting.
              </p>
            </div>
          )}
          {setup === "multi" && !detection.hasUncommittedChanges && (
            <StatusLine icon="success" text="Working tree is clean" />
          )}
        </div>
      )}
    </div>
  );
}

function DetectedUrlPanel({
  setup,
  onSetupChange,
  cloneDestination,
  onBrowseDestination,
}: {
  setup: WorkspaceSetup;
  onSetupChange: (v: WorkspaceSetup) => void;
  cloneDestination: string;
  onBrowseDestination: () => void;
}) {
  return (
    <div className="space-y-4">
      <StatusLine icon="success" text="Git URL detected" />

      <FieldGroup label="Clone to">
        <div className="flex gap-1.5">
          <input
            type="text"
            value={cloneDestination}
            readOnly
            className="bg-input/30 border-border text-foreground h-8 flex-1 rounded-md border px-3 text-xs outline-none"
          />
          <Button variant="outline" size="sm" onClick={onBrowseDestination}>
            Browse
          </Button>
        </div>
      </FieldGroup>

      <FieldGroup label="Workspace setup">
        <WorkspaceSetupPicker value={setup} onChange={onSetupChange} />
      </FieldGroup>
    </div>
  );
}

function DetectedNonRepoPanel({
  name,
  onNameChange,
  setup,
  onSetupChange,
}: {
  name: string;
  onNameChange: (v: string) => void;
  setup: WorkspaceSetup;
  onSetupChange: (v: WorkspaceSetup) => void;
}) {
  return (
    <div className="space-y-4">
      <StatusLine icon="info" text="Not a git repository" />

      <FieldGroup label="Name">
        <input
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          className="bg-input/30 border-border text-foreground focus:border-ring h-8 w-full rounded-md border px-3 text-xs outline-none"
        />
      </FieldGroup>

      <FieldGroup label="Workspace setup">
        <WorkspaceSetupPicker value={setup} onChange={onSetupChange} />
      </FieldGroup>
    </div>
  );
}

// --- Shared UI primitives ---

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-foreground mb-1.5 block text-xs font-medium">{label}</label>
      {children}
    </div>
  );
}

function WorkspaceSetupPicker({
  value,
  onChange,
}: {
  value: WorkspaceSetup;
  onChange: (v: WorkspaceSetup) => void;
}) {
  return (
    <div className="space-y-1.5">
      <SetupOption
        selected={value === "single"}
        onClick={() => onChange("single")}
        title="Single workspace"
        description="One workspace for your project. Simple and straightforward."
      />
      <SetupOption
        selected={value === "multi"}
        onClick={() => onChange("multi")}
        title="Multi-workspace"
        description="Work on multiple tasks in parallel, each in its own isolated workspace."
        recommended
      />
    </div>
  );
}

function SetupOption({
  selected,
  onClick,
  title,
  description,
  recommended,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  description: string;
  recommended?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full cursor-pointer rounded-md border px-3 py-2.5 text-left transition-colors",
        selected
          ? "border-primary/50 bg-primary/5"
          : "border-border bg-muted/20 hover:border-border/80",
      )}
    >
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "flex size-3.5 shrink-0 items-center justify-center rounded-full border",
            selected ? "border-primary bg-primary" : "border-muted-foreground/50",
          )}
        >
          {selected && <div className="size-1.5 rounded-full bg-white" />}
        </div>
        <span className="text-foreground text-xs font-medium">{title}</span>
        {recommended && (
          <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] font-medium">
            recommended
          </span>
        )}
      </div>
      <p className="text-muted-foreground mt-1 pl-5.5 text-[11px]">{description}</p>
    </button>
  );
}

function StatusLine({ icon, text }: { icon: "success" | "error" | "info"; text: string }) {
  return (
    <div className="flex items-center gap-1.5">
      {icon === "success" && <GitBranchIcon className="text-primary size-3.5 shrink-0" />}
      {icon === "error" && <XCircleIcon className="text-destructive size-3.5 shrink-0" />}
      {icon === "info" && <InfoIcon className="text-muted-foreground size-3.5 shrink-0" />}
      <span
        className={cn(
          "text-xs",
          icon === "success" && "text-primary",
          icon === "error" && "text-destructive",
          icon === "info" && "text-muted-foreground",
        )}
      >
        {text}
      </span>
    </div>
  );
}

function SourceIcon({ type }: { type: DetectPathResult["type"] | undefined }) {
  if (type === "git-url") return <GlobeIcon className="text-primary size-3.5 shrink-0" />;
  if (type === "git-repo-bare" || type === "git-repo-regular")
    return <GitBranchIcon className="text-primary size-3.5 shrink-0" />;
  return <FolderIcon className="text-muted-foreground size-3.5 shrink-0" />;
}
