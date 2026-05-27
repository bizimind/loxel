import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModalErrorBoundary } from "@/components/ui/modal-error-boundary";
import { type ModelEntry, isApiKeyError } from "@/store/settings-store";

interface ModelFormDialogProps {
  open: boolean;
  editingModel: ModelEntry | null;
  onSave: (data: { label: string; modelId: string; apiKey: string }) => void;
  onCancel: () => void;
}

export function ModelFormDialog({ open, editingModel, onSave, onCancel }: ModelFormDialogProps) {
  const [label, setLabel] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const labelRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setLabel(editingModel?.label ?? "");
    setModelId(editingModel?.modelId ?? "");
    const key = editingModel?.apiKey;
    setApiKey(key && !isApiKeyError(key) ? key : "");
    setShowKey(false);
    requestAnimationFrame(() => labelRef.current?.focus());
  }, [open, editingModel]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onCancel]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onCancel();
    },
    [onCancel],
  );

  const canSave = label.trim() && modelId.trim() && apiKey.trim();

  const handleSubmit = useCallback(() => {
    if (!canSave) return;
    onSave({ label: label.trim(), modelId: modelId.trim(), apiKey: apiKey.trim() });
  }, [canSave, label, modelId, apiKey, onSave]);

  if (!open) return null;

  return createPortal(
    <ModalErrorBoundary name="Model form" onClose={onCancel}>
      <div
        className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40"
        onClick={handleBackdropClick}
      >
        <div className="bg-popover border-border w-[400px] rounded-lg border shadow-2xl">
          <div className="px-5 pt-5 pb-1">
            <h3 className="text-foreground text-sm font-medium">
              {editingModel ? "Edit Model" : "Add Model"}
            </h3>
            <p className="text-muted-foreground mt-0.5 text-[10px]">
              Provider: <span className="text-foreground font-medium">OpenRouter</span>
            </p>
          </div>

          <div className="space-y-3 px-5 py-3">
            <FieldGroup label="Display Name">
              <Input
                ref={labelRef}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Claude Haiku"
                className="h-8 text-xs"
              />
            </FieldGroup>

            <FieldGroup label="Model ID">
              <Input
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                placeholder="e.g. anthropic/claude-3-haiku"
                className="h-8 text-xs"
              />
            </FieldGroup>

            <FieldGroup label="API Key">
              <div className="relative">
                <Input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-or-v1-..."
                  className="h-8 pr-8 text-xs"
                />
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2.5 -translate-y-1/2"
                  onClick={() => setShowKey((s) => !s)}
                  tabIndex={-1}
                >
                  {showKey ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                </button>
              </div>
              {editingModel && isApiKeyError(editingModel.apiKey) && (
                <p className="text-destructive text-[10px]">
                  {editingModel.apiKey.err} — please re-enter the key.
                </p>
              )}
            </FieldGroup>
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3">
            <Button variant="ghost" size="xs" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="xs" disabled={!canSave} onClick={handleSubmit}>
              {editingModel ? "Save" : "Add"}
            </Button>
          </div>
        </div>
      </div>
    </ModalErrorBoundary>,
    document.body,
  );
}

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-muted-foreground text-xs">{label}</label>
      {children}
    </div>
  );
}
