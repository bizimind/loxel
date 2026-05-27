import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { type ModelEntry, isApiKeyError, useSettingsStore } from "@/store/settings-store";

import { ModelFormDialog } from "./ModelFormDialog";

export function ModelsSection() {
  const models = useSettingsStore((s) => s.models);
  const addModel = useSettingsStore((s) => s.addModel);
  const updateModel = useSettingsStore((s) => s.updateModel);
  const removeModel = useSettingsStore((s) => s.removeModel);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<ModelEntry | null>(null);

  const handleAdd = useCallback(() => {
    setEditingModel(null);
    setDialogOpen(true);
  }, []);

  const handleEdit = useCallback((model: ModelEntry) => {
    setEditingModel(model);
    setDialogOpen(true);
  }, []);

  const handleSave = useCallback(
    (data: { label: string; modelId: string; apiKey: string }) => {
      if (editingModel) {
        updateModel(editingModel.id, data);
      } else {
        addModel({ ...data, provider: "openrouter" });
      }
      setDialogOpen(false);
    },
    [editingModel, addModel, updateModel],
  );

  const handleCancel = useCallback(() => setDialogOpen(false), []);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-foreground text-sm font-medium">Models</h3>
          <p className="text-muted-foreground mt-1 text-xs">
            Manage model configurations for the coding agent.
          </p>
        </div>
        <Button variant="outline" size="xs" onClick={handleAdd}>
          <PlusIcon data-icon="inline-start" className="size-3" />
          Add Model
        </Button>
      </div>

      {models.length === 0 ? (
        <div className="rounded-md bg-[var(--surface-2)] px-4 py-6 text-center">
          <p className="text-muted-foreground text-xs">No models configured yet.</p>
          <p className="text-muted-foreground mt-1 text-[10px]">
            Add a model to get started with the coding agent.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {models.map((model) => (
            <div
              key={model.id}
              className="flex items-center gap-3 rounded-md bg-[var(--surface-2)] px-3 py-2.5"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="text-foreground truncate text-xs font-medium">{model.label}</span>
                <span className="text-muted-foreground shrink-0 rounded bg-[var(--surface-0)] px-1.5 py-0.5 text-[9px] font-medium uppercase">
                  {model.provider}
                </span>
                {isApiKeyError(model.apiKey) && (
                  <span className="text-destructive shrink-0 text-[10px]">Key unavailable</span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  className="text-muted-foreground hover:text-foreground rounded p-1 transition-colors hover:bg-[var(--surface-0)]"
                  onClick={() => handleEdit(model)}
                >
                  <PencilIcon className="size-3" />
                </button>
                <button
                  className="text-muted-foreground hover:text-destructive rounded p-1 transition-colors hover:bg-[var(--surface-0)]"
                  onClick={() => removeModel(model.id)}
                >
                  <Trash2Icon className="size-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ModelFormDialog
        open={dialogOpen}
        editingModel={editingModel}
        onSave={handleSave}
        onCancel={handleCancel}
      />
    </div>
  );
}
