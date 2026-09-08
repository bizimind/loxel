import type { LucideIcon } from "lucide-react";
import {
  BotIcon,
  BrainCircuitIcon,
  CodeIcon,
  FileJson2Icon,
  FileTypeIcon,
  GitBranchIcon,
  KeyboardIcon,
  PanelsLeftBottomIcon,
  SettingsIcon,
  TerminalSquareIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";

import * as api from "@/api/client";
import { Button } from "@/components/ui/button";
import { ModalErrorBoundary } from "@/components/ui/modal-error-boundary";
import { frontendLog } from "@/lib/frontend-logger";
import { syncSchemas } from "@/lib/schema-sync";
import type { SettingsState } from "@/store/settings-store";
import {
  getDirtyWtConfigs,
  selectIsWtConfigDirty,
  selectWtConfigHasAnyErrors,
  useSettingsStore,
} from "@/store/settings-store";

import { CodingAgentSection } from "./CodingAgentSection";
import { EditorSection } from "./EditorSection";
import { FileAssociationsSection } from "./FileAssociationsSection";
import { GeneralSection } from "./GeneralSection";
import { KeybindingsSection } from "./KeybindingsSection";
import { LayoutSection } from "./LayoutSection";
import { ModelsSection } from "./ModelsSection";
import { SchemasSection } from "./SchemasSection";
import { TerminalSection } from "./TerminalSection";
import { WorktreesSection } from "./WorktreesSection";

interface SectionDef {
  key: string;
  label: string;
  icon: LucideIcon;
}

const SECTIONS: SectionDef[] = [
  { key: "general", label: "General", icon: SettingsIcon },
  { key: "models", label: "Models", icon: BrainCircuitIcon },
  { key: "codingAgent", label: "Coding Agent", icon: BotIcon },
  { key: "keybindings", label: "Keybindings", icon: KeyboardIcon },
  { key: "layout", label: "Layout", icon: PanelsLeftBottomIcon },
  { key: "terminal", label: "Terminal", icon: TerminalSquareIcon },
  { key: "editor", label: "Editor", icon: CodeIcon },
  { key: "schemas", label: "Schemas", icon: FileJson2Icon },
  { key: "fileAssociations", label: "File Associations", icon: FileTypeIcon },
  { key: "worktrees", label: "Worktrees", icon: GitBranchIcon },
];

export function SettingsModal() {
  const isOpen = useSettingsStore((s) => s.isOpen);
  const activeSection = useSettingsStore((s) => s.activeSection);
  const closeSettings = useSettingsStore((s) => s.closeSettings);
  const resetWtConfigState = useSettingsStore((s) => s.resetWtConfigState);

  // Live state for dirty tracking
  const models = useSettingsStore((s) => s.models);
  const codingAgent = useSettingsStore((s) => s.codingAgent);
  const layout = useSettingsStore((s) => s.layout);
  const terminal = useSettingsStore((s) => s.terminal);
  const editor = useSettingsStore((s) => s.editor);
  const schemas = useSettingsStore((s) => s.schemas);
  const fileAssociations = useSettingsStore((s) => s.fileAssociations);

  // Wt config dirty tracking
  const isWtConfigDirty = useSettingsStore(selectIsWtConfigDirty);
  const wtConfigHasAnyErrors = useSettingsStore(selectWtConfigHasAnyErrors);

  // Snapshot taken when modal opens
  const snapshotRef = useRef<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      const { models, codingAgent, layout, terminal, editor, schemas, fileAssociations } =
        useSettingsStore.getState();
      snapshotRef.current = JSON.stringify({
        models,
        codingAgent,
        layout,
        terminal,
        editor,
        schemas,
        fileAssociations,
      });
      resetWtConfigState();
    } else {
      snapshotRef.current = null;
    }
    // resetWtConfigState is stable — safe to omit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const isSettingsDirty = useMemo(() => {
    if (!snapshotRef.current) return false;
    return (
      JSON.stringify({
        models,
        codingAgent,
        layout,
        terminal,
        editor,
        schemas,
        fileAssociations,
      }) !== snapshotRef.current
    );
  }, [models, codingAgent, layout, terminal, editor, schemas, fileAssociations]);

  const isDirty = isSettingsDirty || isWtConfigDirty;
  const saveDisabled = !isDirty || (isWtConfigDirty && !isSettingsDirty && wtConfigHasAnyErrors);

  const handleSave = useCallback(async () => {
    // Save all dirty wt.yaml files (skipping those with errors)
    const dirtyConfigs = getDirtyWtConfigs(useSettingsStore.getState());
    for (const { projectId, content } of dirtyConfigs) {
      try {
        await api.saveWtConfigRaw(projectId, content);
      } catch (err) {
        frontendLog
          .child("ui")
          .error("Failed to save wt.yaml", {
            projectId,
            error: err instanceof Error ? err : undefined,
          });
        // TODO: surface error in UI (toast / inline banner)
        return;
      }
    }
    // Settings state is already in the store and auto-persisted — just close.
    // Trigger schema sync so changes take effect immediately.
    closeSettings();
    syncSchemas();
  }, [closeSettings]);

  const handleCancel = useCallback(() => {
    // Restore settings snapshot
    if (snapshotRef.current) {
      const parsed: unknown = JSON.parse(snapshotRef.current);
      if (typeof parsed === "object" && parsed !== null && "models" in parsed) {
        useSettingsStore.setState(
          parsed as Pick<
            SettingsState,
            | "models"
            | "codingAgent"
            | "layout"
            | "terminal"
            | "editor"
            | "schemas"
            | "fileAssociations"
          >,
        );
      }
    }
    // Wt config state is transient — resetWtConfigState happens on next open
    closeSettings();
  }, [closeSettings]);

  // Escape to cancel
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleCancel]);

  // Scroll to the requested section when modal opens
  useEffect(() => {
    if (!isOpen) return;
    if (activeSection === "general") return;
    requestAnimationFrame(() => {
      const el = document.getElementById(`settings-${activeSection}`);
      if (el) el.scrollIntoView({ block: "start" });
    });
  }, [isOpen, activeSection]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) handleCancel();
    },
    [handleCancel],
  );

  if (!isOpen) return null;

  return createPortal(
    <ModalErrorBoundary name="Settings" onClose={handleCancel}>
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50"
        onClick={handleBackdropClick}
      >
        <div className="bg-popover border-border flex max-h-[85vh] w-full max-w-[min(calc(100%-2rem),960px)] flex-col overflow-hidden rounded-lg border shadow-2xl">
          {/* Full-width header */}
          <div className="border-border flex shrink-0 items-center justify-between border-b px-5 py-2">
            <span className="text-foreground text-sm font-semibold">Settings</span>
            <button
              className="text-muted-foreground hover:text-foreground rounded-md p-1 transition-colors hover:bg-[var(--surface-2)]"
              onClick={handleCancel}
            >
              <XIcon className="size-4" />
            </button>
          </div>

          {/* Body: left nav + right content */}
          <div className="flex min-h-0 flex-1">
            {/* Left nav — CSS scrollspy via scroll-target-group */}
            <nav className="settings-scrollspy border-border flex w-[180px] shrink-0 flex-col gap-0.5 border-r p-3">
              {SECTIONS.map((section) => (
                <a
                  key={section.key}
                  href={`#settings-${section.key}`}
                  className="settings-nav-link text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs no-underline transition-colors"
                >
                  <section.icon className="size-3.5" />
                  {section.label}
                </a>
              ))}
            </nav>

            {/* Right content — all sections in one scroll container */}
            <div className="flex-1 overflow-y-auto scroll-smooth p-5">
              <div id="settings-general">
                <GeneralSection />
              </div>

              <div id="settings-models" className="border-border mt-8 border-t pt-8">
                <ModelsSection />
              </div>

              <div id="settings-codingAgent" className="border-border mt-8 border-t pt-8">
                <CodingAgentSection />
              </div>

              <div id="settings-keybindings" className="border-border mt-8 border-t pt-8">
                <KeybindingsSection />
              </div>

              <div id="settings-layout" className="border-border mt-8 border-t pt-8">
                <LayoutSection />
              </div>

              <div id="settings-terminal" className="border-border mt-8 border-t pt-8">
                <TerminalSection />
              </div>

              <div id="settings-editor" className="border-border mt-8 border-t pt-8">
                <EditorSection />
              </div>

              <div id="settings-schemas" className="border-border mt-8 border-t pt-8">
                <SchemasSection />
              </div>

              <div id="settings-fileAssociations" className="border-border mt-8 border-t pt-8">
                <FileAssociationsSection />
              </div>

              <div id="settings-worktrees" className="border-border mt-8 border-t pt-8">
                <WorktreesSection />
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="border-border flex shrink-0 items-center justify-end gap-2 border-t px-5 py-2.5">
            <Button variant="ghost" size="xs" onClick={handleCancel}>
              Cancel
            </Button>
            <Button size="xs" disabled={saveDisabled} onClick={handleSave}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </ModalErrorBoundary>,
    document.body,
  );
}
