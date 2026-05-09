import { PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback } from "react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  BUILTIN_SCHEMA_DEFAULTS,
  selectEffectiveSchemas,
  useSettingsStore,
} from "@/store/settings-store";

import { EditableCell } from "./EditableCell";

const BUILTIN_IDS = new Set(BUILTIN_SCHEMA_DEFAULTS.map((b) => b.id));

export function SchemasSection() {
  const schemas = useSettingsStore(selectEffectiveSchemas);
  const addSchema = useSettingsStore((s) => s.addSchema);
  const updateSchema = useSettingsStore((s) => s.updateSchema);
  const removeSchema = useSettingsStore((s) => s.removeSchema);
  const toggleSchema = useSettingsStore((s) => s.toggleSchema);

  const handleAdd = useCallback(() => {
    addSchema("**/*.json", "https://");
  }, [addSchema]);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h3 className="text-foreground text-sm font-medium">Schemas</h3>
          <p className="text-muted-foreground mt-1 text-xs">
            Configure JSON Schema mappings for auto-completion and validation in JSON and YAML
            files.
          </p>
        </div>
        <Button variant="outline" size="xs" onClick={handleAdd}>
          <PlusIcon data-icon="inline-start" className="size-3" />
          Add Schema
        </Button>
      </div>

      <div className="divide-border/50 divide-y rounded-md bg-[var(--surface-2)]">
        {/* Header */}
        <div className="text-muted-foreground grid grid-cols-[1fr_1fr_28px_28px] items-center gap-2 px-3 py-1.5 text-[10px] font-medium tracking-wider uppercase">
          <span>Glob Pattern</span>
          <span>Schema URL</span>
          <span />
          <span />
        </div>

        {/* Schema rows */}
        {schemas.map((schema) => {
          const isBuiltin = BUILTIN_IDS.has(schema.id);
          return (
            <div
              key={schema.id}
              className={cn(
                "group grid grid-cols-[1fr_1fr_28px_28px] items-center gap-2 px-3",
                isBuiltin ? "py-1.5" : "py-0.5",
              )}
            >
              {isBuiltin ? (
                <>
                  <span className="text-muted-foreground truncate text-xs">{schema.glob}</span>
                  <span className="text-muted-foreground flex items-center gap-1.5 truncate text-xs">
                    <span className="truncate">
                      {schema.url === "__builtin:wt-json-schema__"
                        ? "(local wt.yaml schema)"
                        : schema.url}
                    </span>
                    <span className="bg-muted text-muted-foreground shrink-0 rounded px-1 py-0.5 text-[9px] leading-none">
                      Built-in
                    </span>
                  </span>
                  <span />
                </>
              ) : (
                <>
                  <EditableCell
                    value={schema.glob}
                    onChange={(v) => updateSchema(schema.id, { glob: v })}
                    placeholder="**/file.json"
                  />
                  <EditableCell
                    value={schema.url}
                    onChange={(v) => updateSchema(schema.id, { url: v })}
                    placeholder="https://... or /path/to/schema.json"
                  />
                  <button
                    onClick={() => removeSchema(schema.id)}
                    className="text-muted-foreground hover:text-destructive flex size-7 items-center justify-center rounded p-1 opacity-0 transition-colors group-hover:opacity-100"
                  >
                    <Trash2Icon className="size-3.5" />
                  </button>
                </>
              )}
              <Switch checked={schema.enabled} onCheckedChange={() => toggleSchema(schema.id)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
