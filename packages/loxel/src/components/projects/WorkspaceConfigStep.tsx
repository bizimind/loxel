import { CheckIcon, PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "@/api/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SUGGESTED_FILES = [".env", ".env.local", ".envrc"];
const SUGGESTED_COMMANDS = [
  "bun i --frozen-lockfile",
  "npm ci",
  "pnpm i --frozen-lockfile",
  "direnv allow",
  "mise trust",
  "mise i",
];

export interface WorkspaceConfig {
  copyFiles: string[];
  setupCommands: string[];
}

interface WorkspaceConfigStepProps {
  /** Path to scan for auto-detection (null for new projects with no existing files). */
  scanPath: string | null;
  config: WorkspaceConfig;
  onChange: (config: WorkspaceConfig) => void;
  onBack: () => void;
  onSubmit: () => void;
  submitLabel: string;
  submitting?: boolean;
}

export function WorkspaceConfigStep({
  scanPath,
  config,
  onChange,
  onBack,
  onSubmit,
  submitLabel,
  submitting,
}: WorkspaceConfigStepProps) {
  const [addingFile, setAddingFile] = useState(false);
  const [addingCommand, setAddingCommand] = useState(false);
  const [newFile, setNewFile] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!scanPath) return;
    api.scanSuggestions(scanPath).then((result) => {
      if (result.files.length > 0 || result.commands.length > 0) {
        onChangeRef.current({
          copyFiles: [...new Set(result.files)],
          setupCommands: [...new Set(result.commands)],
        });
      }
    });
  }, [scanPath]);

  const removeFile = useCallback(
    (file: string) => {
      onChange({ ...config, copyFiles: config.copyFiles.filter((f) => f !== file) });
    },
    [config, onChange],
  );

  const removeCommand = useCallback(
    (cmd: string) => {
      onChange({ ...config, setupCommands: config.setupCommands.filter((c) => c !== cmd) });
    },
    [config, onChange],
  );

  const addFile = useCallback(
    (file: string) => {
      const trimmed = file.trim();
      if (!trimmed || config.copyFiles.includes(trimmed)) return;
      onChange({ ...config, copyFiles: [...config.copyFiles, trimmed] });
      setNewFile("");
      setAddingFile(false);
    },
    [config, onChange],
  );

  const addCommand = useCallback(
    (cmd: string) => {
      const trimmed = cmd.trim();
      if (!trimmed || config.setupCommands.includes(trimmed)) return;
      onChange({ ...config, setupCommands: [...config.setupCommands, trimmed] });
      setNewCommand("");
      setAddingCommand(false);
    },
    [config, onChange],
  );

  const unusedFileSuggestions = SUGGESTED_FILES.filter((f) => !config.copyFiles.includes(f));
  const unusedCommandSuggestions = SUGGESTED_COMMANDS.filter(
    (c) => !config.setupCommands.includes(c),
  );
  const showSuggestions =
    !scanPath && (unusedFileSuggestions.length > 0 || unusedCommandSuggestions.length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {/* Files section */}
        <div>
          <h4 className="text-foreground mb-1 text-xs font-medium">
            Files to copy to each workspace
          </h4>
          <p className="text-muted-foreground mb-2 text-[11px]">
            Each new workspace gets a copy of these files so it can run independently.
          </p>

          {config.copyFiles.length > 0 && (
            <div className="mb-2 space-y-1">
              {config.copyFiles.map((file) => (
                <div
                  key={file}
                  className="bg-muted/50 flex items-center gap-2 rounded px-2.5 py-1.5"
                >
                  <CheckIcon className="text-primary size-3 shrink-0" />
                  <span className="text-foreground flex-1 text-xs">{file}</span>
                  <button
                    onClick={() => removeFile(file)}
                    className="text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {addingFile ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                addFile(newFile);
              }}
              className="flex items-center gap-1.5"
            >
              <input
                type="text"
                value={newFile}
                onChange={(e) => setNewFile(e.target.value)}
                placeholder=".env.production"
                className="bg-input/30 border-border text-foreground placeholder:text-muted-foreground focus:border-ring h-7 flex-1 rounded border px-2 text-xs outline-none"
                autoFocus
              />
              <Button type="submit" size="xs" disabled={!newFile.trim()}>
                Add
              </Button>
              <Button type="button" variant="ghost" size="xs" onClick={() => setAddingFile(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <button
              onClick={() => setAddingFile(true)}
              className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1 text-xs"
            >
              <PlusIcon className="size-3" />
              Add file
            </button>
          )}
        </div>

        {/* Commands section */}
        <div>
          <h4 className="text-foreground mb-1 text-xs font-medium">Setup commands</h4>
          <p className="text-muted-foreground mb-2 text-[11px]">
            Run when creating a new workspace.
          </p>

          {config.setupCommands.length > 0 && (
            <div className="mb-2 space-y-1">
              {config.setupCommands.map((cmd) => (
                <div
                  key={cmd}
                  className="bg-muted/50 flex items-center gap-2 rounded px-2.5 py-1.5"
                >
                  <CheckIcon className="text-primary size-3 shrink-0" />
                  <span className="text-foreground flex-1 font-mono text-xs">{cmd}</span>
                  <button
                    onClick={() => removeCommand(cmd)}
                    className="text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {addingCommand ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                addCommand(newCommand);
              }}
              className="flex items-center gap-1.5"
            >
              <input
                type="text"
                value={newCommand}
                onChange={(e) => setNewCommand(e.target.value)}
                placeholder="bun i --frozen-lockfile"
                className="bg-input/30 border-border text-foreground placeholder:text-muted-foreground focus:border-ring h-7 flex-1 rounded border px-2 font-mono text-xs outline-none"
                autoFocus
              />
              <Button type="submit" size="xs" disabled={!newCommand.trim()}>
                Add
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setAddingCommand(false)}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <button
              onClick={() => setAddingCommand(true)}
              className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1 text-xs"
            >
              <PlusIcon className="size-3" />
              Add command
            </button>
          )}
        </div>

        {/* Suggestion chips for new projects */}
        {showSuggestions && (
          <div>
            <h4 className="text-muted-foreground mb-2 text-[11px]">Suggested</h4>
            <div className="flex flex-wrap gap-1.5">
              {unusedFileSuggestions.map((f) => (
                <SuggestionChip key={f} label={f} onClick={() => addFile(f)} />
              ))}
              {unusedCommandSuggestions.map((c) => (
                <SuggestionChip key={c} label={c} onClick={() => addCommand(c)} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-border flex items-center justify-end gap-2 border-t px-5 py-3">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <Button size="sm" onClick={onSubmit} disabled={submitting}>
          {submitting ? "Working..." : submitLabel}
        </Button>
      </div>
    </div>
  );
}

function SuggestionChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "border-border bg-muted/30 text-muted-foreground hover:border-primary/50 hover:text-foreground",
        "cursor-pointer rounded-full border px-2.5 py-0.5 text-[11px] transition-colors",
      )}
    >
      {label}
    </button>
  );
}
