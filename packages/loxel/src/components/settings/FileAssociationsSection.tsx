import { PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { EXT_TO_LANG, FILENAME_TO_LANG } from "@/lib/highlighter";
import { cn } from "@/lib/utils";
import {
  BUILTIN_FILE_ASSOCIATIONS,
  selectEffectiveFileAssociations,
  useSettingsStore,
} from "@/store/settings-store";

import { EditableCell } from "./EditableCell";

const BUILTIN_IDS = new Set(BUILTIN_FILE_ASSOCIATIONS.map((b) => b.id));

/** All known language IDs, sorted alphabetically. */
const LANGUAGE_OPTIONS = [
  ...new Set([...Object.values(EXT_TO_LANG), ...Object.values(FILENAME_TO_LANG)]),
].sort();

function LanguageSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <select
        autoFocus
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setEditing(false);
        }}
        onBlur={() => setEditing(false)}
        className="border-input bg-background h-6 truncate rounded border px-1 text-xs"
      >
        {LANGUAGE_OPTIONS.map((lang) => (
          <option key={lang} value={lang}>
            {lang}
          </option>
        ))}
      </select>
    );
  }

  return (
    <button onClick={() => setEditing(true)} className="text-foreground truncate text-left text-xs">
      {value}
    </button>
  );
}

export function FileAssociationsSection() {
  const associations = useSettingsStore(selectEffectiveFileAssociations);
  const addFileAssociation = useSettingsStore((s) => s.addFileAssociation);
  const updateFileAssociation = useSettingsStore((s) => s.updateFileAssociation);
  const removeFileAssociation = useSettingsStore((s) => s.removeFileAssociation);
  const toggleFileAssociation = useSettingsStore((s) => s.toggleFileAssociation);

  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    if (!filter) return associations;
    const q = filter.toLowerCase();
    return associations.filter(
      (a) => a.glob.toLowerCase().includes(q) || a.language.toLowerCase().includes(q),
    );
  }, [associations, filter]);

  const handleAdd = useCallback(() => {
    addFileAssociation("**/*.json", "jsonc");
  }, [addFileAssociation]);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-foreground text-sm font-medium">File Associations</h3>
          <p className="text-muted-foreground mt-1 text-xs">
            Map file patterns to language modes. First match wins — user entries take precedence
            over built-in defaults.
          </p>
        </div>
        <Button variant="outline" size="xs" onClick={handleAdd}>
          <PlusIcon data-icon="inline-start" className="size-3" />
          Add Association
        </Button>
      </div>

      {/* Filter */}
      <div className="relative">
        <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2" />
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by pattern or language..."
          className="border-input bg-background h-7 w-full rounded border pr-2 pl-7 text-xs"
        />
      </div>

      <div className="divide-border/50 max-h-[320px] divide-y overflow-y-auto rounded-md bg-[var(--surface-2)]">
        {/* Header */}
        <div className="text-muted-foreground sticky top-0 z-10 grid grid-cols-[1fr_1fr_28px_28px] items-center gap-2 bg-[var(--surface-2)] px-3 py-1.5 text-[10px] font-medium tracking-wider uppercase">
          <span>Glob Pattern</span>
          <span>Language</span>
          <span />
          <span />
        </div>

        {/* Association rows */}
        {filtered.map((assoc) => {
          const isBuiltin = BUILTIN_IDS.has(assoc.id);
          return (
            <div
              key={assoc.id}
              className={cn(
                "group grid grid-cols-[1fr_1fr_28px_28px] items-center gap-2 px-3",
                isBuiltin ? "py-1.5" : "py-0.5",
              )}
            >
              {isBuiltin ? (
                <>
                  <span className="text-muted-foreground truncate text-xs">{assoc.glob}</span>
                  <span className="text-muted-foreground flex items-center gap-1.5 truncate text-xs">
                    <span className="truncate">{assoc.language}</span>
                    <span className="bg-muted text-muted-foreground shrink-0 rounded px-1 py-0.5 text-[9px] leading-none">
                      Built-in
                    </span>
                  </span>
                  <span />
                </>
              ) : (
                <>
                  <EditableCell
                    value={assoc.glob}
                    onChange={(v) => updateFileAssociation(assoc.id, { glob: v })}
                    placeholder="**/file.json"
                  />
                  <LanguageSelect
                    value={assoc.language}
                    onChange={(v) => updateFileAssociation(assoc.id, { language: v })}
                  />
                  <button
                    onClick={() => removeFileAssociation(assoc.id)}
                    className="text-muted-foreground hover:text-destructive flex size-7 items-center justify-center rounded p-1 opacity-0 transition-colors group-hover:opacity-100"
                  >
                    <Trash2Icon className="size-3.5" />
                  </button>
                </>
              )}
              <Switch
                checked={assoc.enabled}
                onCheckedChange={() => toggleFileAssociation(assoc.id)}
              />
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div className="text-muted-foreground px-3 py-3 text-center text-xs">
            No associations match &quot;{filter}&quot;
          </div>
        )}
      </div>
    </div>
  );
}
