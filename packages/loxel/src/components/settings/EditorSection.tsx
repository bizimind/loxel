import { PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { DetectedFormatter } from "@/api/client";
import type { FormatterOverride } from "@/lib/formatting-model";
import type { IndentationOverride } from "@/store/settings-store";

import * as api from "@/api/client";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { DEFAULT_EDITOR_SETTINGS, useSettingsStore } from "@/store/settings-store";
import { useWorktreeStore } from "@/store/worktrees";

export function EditorSection() {
  const indentation = useSettingsStore((s) => s.editor.indentation);
  const overrides = useSettingsStore((s) => s.editor.overrides);
  const updateEditorIndentation = useSettingsStore((s) => s.updateEditorIndentation);
  const addEditorOverride = useSettingsStore((s) => s.addEditorOverride);
  const updateEditorOverride = useSettingsStore((s) => s.updateEditorOverride);
  const removeEditorOverride = useSettingsStore((s) => s.removeEditorOverride);

  const formatting = useSettingsStore((s) => s.editor.formatting);
  const updateFormatting = useSettingsStore((s) => s.updateFormatting);
  const addFormatterOverride = useSettingsStore((s) => s.addFormatterOverride);
  const updateFormatterOverride = useSettingsStore((s) => s.updateFormatterOverride);
  const removeFormatterOverride = useSettingsStore((s) => s.removeFormatterOverride);

  // Local string state for tab size input — commit to store on blur.
  const [localTabSize, setLocalTabSize] = useState(String(indentation.tabSize));

  // Sync when store changes externally (e.g. cancel/revert).
  useEffect(() => setLocalTabSize(String(indentation.tabSize)), [indentation.tabSize]);

  const handleTabSizeBlur = useCallback(() => {
    const value = Number.parseInt(localTabSize, 10);
    if (Number.isFinite(value) && value >= 1 && value <= 8) {
      updateEditorIndentation({ tabSize: value });
    } else {
      setLocalTabSize(String(indentation.tabSize));
    }
  }, [localTabSize, indentation.tabSize, updateEditorIndentation]);

  const handleAdd = useCallback(() => {
    addEditorOverride(
      "",
      DEFAULT_EDITOR_SETTINGS.indentation.tabSize,
      DEFAULT_EDITOR_SETTINGS.indentation.insertSpaces,
    );
  }, [addEditorOverride]);

  const handleAddFormatter = useCallback(() => {
    addFormatterOverride("", "", "");
  }, [addFormatterOverride]);

  // Fetch detected formatters for the active worktree
  const activeWorktreePath = useWorktreeStore((s) => s.activeWorktreePath);
  const [detectedFormatters, setDetectedFormatters] = useState<DetectedFormatter[]>([]);
  useEffect(() => {
    if (!activeWorktreePath || !formatting.autoDetect) {
      setDetectedFormatters([]);
      return;
    }
    let cancelled = false;
    api
      .getDetectedFormatters(activeWorktreePath)
      .then((result) => {
        if (!cancelled) setDetectedFormatters(result);
      })
      .catch((err) => {
        console.warn("[EditorSection] Failed to fetch detected formatters:", err);
        if (!cancelled) setDetectedFormatters([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorktreePath, formatting.autoDetect]);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-foreground text-sm font-medium">Editor</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          Configure editor indentation and formatting.
        </p>
      </div>

      {/* --- Indentation --- */}
      <div className="space-y-1.5">
        <label className="text-muted-foreground text-xs">Default Indentation</label>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-[10px]">Tab Size</span>
            <Input
              type="number"
              value={localTabSize}
              onChange={(e) => setLocalTabSize(e.target.value)}
              onBlur={handleTabSizeBlur}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleTabSizeBlur();
              }}
              min={1}
              max={8}
              className="h-7 w-16 text-xs"
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={indentation.insertSpaces}
              onChange={() => updateEditorIndentation({ insertSpaces: !indentation.insertSpaces })}
              className="accent-primary size-3.5 rounded"
            />
            <span className="text-foreground text-xs">Insert Spaces</span>
          </label>
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-muted-foreground text-xs">Per-Extension Overrides</label>

        {overrides.length > 0 && (
          <div className="space-y-1">
            <div className="text-muted-foreground grid grid-cols-[100px_80px_80px_28px] gap-2 px-1 text-[10px] font-medium tracking-wide uppercase">
              <span>Extension</span>
              <span>Tab Size</span>
              <span>Spaces</span>
              <span />
            </div>

            {overrides.map((override) => (
              <IndentOverrideRow
                key={override.id}
                id={override.id}
                extension={override.extension}
                tabSize={override.tabSize}
                insertSpaces={override.insertSpaces}
                onUpdate={updateEditorOverride}
                onRemove={removeEditorOverride}
              />
            ))}
          </div>
        )}

        <button
          onClick={handleAdd}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors hover:bg-[var(--surface-2)]"
        >
          <PlusIcon className="size-3.5" />
          Add Override
        </button>
      </div>

      {/* --- Formatting --- */}
      <div className="border-border space-y-3 border-t pt-4">
        <label className="text-muted-foreground text-xs">Formatting</label>

        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={formatting.enabled}
              onChange={() => updateFormatting({ enabled: !formatting.enabled })}
              className="accent-primary size-3.5 rounded"
            />
            <span className="text-foreground text-xs">Format on explicit save (Cmd+S)</span>
          </label>

          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={formatting.formatOnAutoSave}
              onChange={() => updateFormatting({ formatOnAutoSave: !formatting.formatOnAutoSave })}
              className="accent-primary size-3.5 rounded"
              disabled={!formatting.enabled}
            />
            <span
              className={cn(
                "text-xs",
                formatting.enabled ? "text-foreground" : "text-muted-foreground",
              )}
            >
              Also format on auto-save
            </span>
          </label>

          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={formatting.autoDetect}
              onChange={() => updateFormatting({ autoDetect: !formatting.autoDetect })}
              className="accent-primary size-3.5 rounded"
              disabled={!formatting.enabled}
            />
            <span
              className={cn(
                "text-xs",
                formatting.enabled ? "text-foreground" : "text-muted-foreground",
              )}
            >
              Auto-detect formatters from project config
            </span>
          </label>

          {formatting.enabled && formatting.autoDetect && detectedFormatters.length > 0 && (
            <div className="ml-6 space-y-1">
              {detectedFormatters.map((fmt) => (
                <div key={fmt.command} className="text-muted-foreground text-xs">
                  <span className="text-foreground font-medium">{fmt.command}</span>
                  {" — "}
                  {fmt.extensions.join(", ")}
                </div>
              ))}
            </div>
          )}

          {formatting.enabled &&
            formatting.autoDetect &&
            detectedFormatters.length === 0 &&
            activeWorktreePath && (
              <p className="text-muted-foreground ml-6 text-xs italic">No formatters detected</p>
            )}
        </div>

        {formatting.enabled && (
          <div className="space-y-1.5">
            <label className="text-muted-foreground text-xs">Manual Overrides</label>

            {formatting.overrides.length > 0 && (
              <div className="space-y-1">
                <div className="text-muted-foreground grid grid-cols-[100px_100px_1fr_28px] gap-2 px-1 text-[10px] font-medium tracking-wide uppercase">
                  <span>Extensions</span>
                  <span>Command</span>
                  <span>Args</span>
                  <span />
                </div>

                {formatting.overrides.map((override) => (
                  <FormatterOverrideRow
                    key={override.id}
                    override={override}
                    onUpdate={updateFormatterOverride}
                    onRemove={removeFormatterOverride}
                  />
                ))}
              </div>
            )}

            <button
              onClick={handleAddFormatter}
              className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors hover:bg-[var(--surface-2)]"
            >
              <PlusIcon className="size-3.5" />
              Add Override
            </button>

            <p className="text-muted-foreground text-[10px]">
              Overrides take precedence over auto-detected formatters. Command receives content on
              stdin and outputs formatted content on stdout. Use {"{file}"} for absolute path and{" "}
              {"{ext}"} for extension in args.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Indentation Override Row (existing, renamed from OverrideRow)
// ---------------------------------------------------------------------------

function IndentOverrideRow({
  id,
  extension,
  tabSize,
  insertSpaces,
  onUpdate,
  onRemove,
}: {
  id: string;
  extension: string;
  tabSize: number;
  insertSpaces: boolean;
  onUpdate: (id: string, updates: Partial<Omit<IndentationOverride, "id">>) => void;
  onRemove: (id: string) => void;
}) {
  const [localTabSize, setLocalTabSize] = useState(String(tabSize));

  useEffect(() => setLocalTabSize(String(tabSize)), [tabSize]);

  const handleTabSizeBlur = useCallback(() => {
    const value = Number.parseInt(localTabSize, 10);
    if (Number.isFinite(value) && value >= 1 && value <= 8) {
      onUpdate(id, { tabSize: value });
    } else {
      setLocalTabSize(String(tabSize));
    }
  }, [localTabSize, tabSize, id, onUpdate]);

  return (
    <div className="grid grid-cols-[100px_80px_80px_28px] items-center gap-2 px-1 py-0.5">
      <input
        type="text"
        value={extension}
        onChange={(e) => onUpdate(id, { extension: e.target.value.replace(/^\./, "") })}
        className="border-input bg-background h-7 rounded border px-2 text-xs"
        placeholder="e.g. go"
      />
      <Input
        type="number"
        value={localTabSize}
        onChange={(e) => setLocalTabSize(e.target.value)}
        onBlur={handleTabSizeBlur}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleTabSizeBlur();
        }}
        min={1}
        max={8}
        className="h-7 text-xs"
      />
      <label className="flex cursor-pointer items-center justify-center">
        <input
          type="checkbox"
          checked={insertSpaces}
          onChange={() => onUpdate(id, { insertSpaces: !insertSpaces })}
          className="accent-primary size-3.5 rounded"
        />
      </label>
      <button
        onClick={() => onRemove(id)}
        className="text-muted-foreground hover:text-destructive flex size-7 items-center justify-center rounded transition-colors hover:bg-[var(--surface-2)]"
      >
        <Trash2Icon className="size-3.5" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatter Override Row
// ---------------------------------------------------------------------------

function FormatterOverrideRow({
  override,
  onUpdate,
  onRemove,
}: {
  override: FormatterOverride;
  onUpdate: (id: string, updates: Partial<Omit<FormatterOverride, "id">>) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-[100px_100px_1fr_28px] items-center gap-2 px-1 py-0.5">
      <input
        type="text"
        value={override.extensions}
        onChange={(e) => onUpdate(override.id, { extensions: e.target.value })}
        className="border-input bg-background h-7 rounded border px-2 text-xs"
        placeholder="ts,tsx,js"
      />
      <input
        type="text"
        value={override.command}
        onChange={(e) => onUpdate(override.id, { command: e.target.value })}
        className="border-input bg-background h-7 rounded border px-2 text-xs"
        placeholder="prettier"
      />
      <input
        type="text"
        value={override.args}
        onChange={(e) => onUpdate(override.id, { args: e.target.value })}
        className="border-input bg-background h-7 rounded border px-2 text-xs"
        placeholder="--stdin-filepath {file}"
      />
      <button
        onClick={() => onRemove(override.id)}
        className="text-muted-foreground hover:text-destructive flex size-7 items-center justify-center rounded transition-colors hover:bg-[var(--surface-2)]"
      >
        <Trash2Icon className="size-3.5" />
      </button>
    </div>
  );
}
