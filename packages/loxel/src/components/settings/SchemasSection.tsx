import { PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback } from "react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { classifySchemaGlob, type SchemaLanguage } from "@/lib/schema-glob";
import { cn } from "@/lib/utils";
import {
  BUILTIN_SCHEMA_DEFAULTS,
  selectEffectiveSchemas,
  useSettingsStore,
} from "@/store/settings-store";

import { EditableCell } from "./EditableCell";

const BUILTIN_IDS = new Set(BUILTIN_SCHEMA_DEFAULTS.map((b) => b.id));

const LANGUAGE_LABELS: Record<SchemaLanguage, string> = {
  json: "JSON",
  yaml: "YAML",
  toml: "TOML",
};

/** The languages a glob's schema applies to, e.g. "TOML" or "JSON, YAML, TOML". */
function languagesLabel(glob: string): string {
  const languages = classifySchemaGlob(glob);
  return (Object.keys(LANGUAGE_LABELS) as SchemaLanguage[])
    .filter((language) => languages[language])
    .map((language) => LANGUAGE_LABELS[language])
    .join(", ");
}

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
            Map JSON Schemas to files for auto-completion, hover and validation in JSON, YAML and
            TOML files. A glob ending in .json/.jsonc, .yml/.yaml or .toml applies to that language,
            any other glob to all three. For TOML files, user mappings take precedence over built-in
            ones.
          </p>
        </div>
        <Button variant="outline" size="xs" onClick={handleAdd}>
          <PlusIcon data-icon="inline-start" className="size-3" />
          Add Schema
        </Button>
      </div>

      <div className="divide-border/50 divide-y rounded-md bg-[var(--surface-2)]">
        {/* Header */}
        <div className="text-muted-foreground grid grid-cols-[1fr_1fr_88px_28px_28px] items-center gap-2 px-3 py-1.5 text-[10px] font-medium tracking-wider uppercase">
          <span>Glob Pattern</span>
          <span>Schema URL</span>
          <span>Languages</span>
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
                "group grid grid-cols-[1fr_1fr_88px_28px_28px] items-center gap-2 px-3",
                isBuiltin ? "py-1.5" : "py-0.5",
              )}
            >
              {isBuiltin ? (
                <>
                  <span className="text-muted-foreground truncate text-xs">{schema.glob}</span>
                  <span className="text-muted-foreground flex items-center gap-1.5 truncate text-xs">
                    <span className="truncate">{schema.url}</span>
                    <span className="bg-muted text-muted-foreground shrink-0 rounded px-1 py-0.5 text-[9px] leading-none">
                      Built-in
                    </span>
                  </span>
                  <LanguagesCell glob={schema.glob} />
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
                  <LanguagesCell glob={schema.glob} />
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

function LanguagesCell({ glob }: { glob: string }) {
  return <span className="text-muted-foreground truncate text-[10px]">{languagesLabel(glob)}</span>;
}
