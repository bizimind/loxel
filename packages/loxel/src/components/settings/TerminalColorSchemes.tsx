import { XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { frontendLog } from "@/lib/frontend-logger";
import {
  ANSI_COLOR_NAMES,
  BUILTIN_TERMINAL_COLOR_SCHEMES,
  resolveTerminalColorScheme,
  type TerminalColorScheme,
  type TerminalSchemeTheme,
} from "@/lib/terminal-color-schemes";
import {
  MAX_SCHEME_FILE_BYTES,
  parseTerminalSchemeFile,
  type ParsedTerminalScheme,
  SchemeImportError,
} from "@/lib/terminal-scheme-import";
import { useSettingsStore } from "@/store/settings-store";

const log = frontendLog.child("terminal");

const THEME_ROWS: { theme: TerminalSchemeTheme; label: string }[] = [
  { theme: "light", label: "Light theme" },
  { theme: "dark", label: "Dark theme" },
];

/** File types the import picker offers; the parser tells the formats apart by content. */
const IMPORT_ACCEPT = ".itermcolors,.json,.jsonc,.plist,.xml";

/** The terminal color scheme rows of Settings > Appearance. */
export function TerminalColorSchemes() {
  const colorSchemes = useSettingsStore((s) => s.terminal.colorSchemes);
  const setScheme = useSettingsStore((s) => s.setTerminalColorScheme);
  const importSchemes = useSettingsStore((s) => s.importTerminalColorSchemes);
  const removeScheme = useSettingsStore((s) => s.removeTerminalColorScheme);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<{ error: boolean; message: string } | null>(null);

  const importFiles = async (files: File[]) => {
    const parsed: ParsedTerminalScheme[] = [];
    const errors: string[] = [];
    for (const file of files) {
      try {
        if (file.size > MAX_SCHEME_FILE_BYTES) {
          throw new SchemeImportError(`${file.name} is too large to be a color scheme.`);
        }
        const { schemes, skipped } = parseTerminalSchemeFile(file.name, await file.text());
        parsed.push(...schemes);
        errors.push(...skipped);
      } catch (error) {
        if (error instanceof SchemeImportError) {
          errors.push(error.message);
          continue;
        }
        // The file went away or became unreadable after it was picked, or the parser failed.
        log.warn("Could not read a terminal color scheme file", { error });
        errors.push(`${file.name} could not be read.`);
      }
    }
    if (parsed.length > 0) importSchemes(parsed);
    const names = [...new Set(parsed.map((s) => s.name))];
    const imported = names.length > 0 ? `Imported ${names.join(", ")}.` : "";
    setStatus({ error: errors.length > 0, message: [...errors, imported].join(" ").trim() });
  };

  return (
    <div className="space-y-1.5">
      <label className="text-muted-foreground text-xs">Terminal Colors</label>
      <p className="text-muted-foreground text-[10px] not-dark:text-[12px]">
        The terminal&apos;s colors in each theme. Import more from iTerm2 (.itermcolors), Windows
        Terminal or VS Code theme files.
      </p>
      <div className="grid grid-cols-[auto_auto_auto] items-center justify-start gap-x-3 gap-y-1.5 pt-0.5">
        {THEME_ROWS.map(({ theme, label }) => {
          const id = `terminal-scheme-${theme}`;
          const scheme = resolveTerminalColorScheme(colorSchemes, theme === "dark");
          return (
            <div key={theme} className="contents">
              <label htmlFor={id} className="text-foreground text-xs">
                {label}
              </label>
              <select
                id={id}
                value={scheme.id}
                onChange={(e) => setScheme(theme, e.target.value)}
                className="border-input text-foreground block h-8 w-48 rounded-md border bg-[var(--surface-2)] px-2 text-xs shadow-sm"
              >
                {BUILTIN_TERMINAL_COLOR_SCHEMES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                {colorSchemes.imported.length > 0 && (
                  <optgroup label="Imported">
                    {colorSchemes.imported.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <SchemePreview scheme={scheme} />
            </div>
          );
        })}
      </div>

      {colorSchemes.imported.length > 0 && (
        <ul aria-label="Imported color schemes" className="space-y-1 pt-1">
          {colorSchemes.imported.map((scheme) => (
            <li key={scheme.id} className="flex items-center gap-2">
              <SchemePreview scheme={scheme} />
              <span className="text-foreground truncate text-xs">{scheme.name}</span>
              <button
                type="button"
                aria-label={`Remove ${scheme.name}`}
                title="Remove"
                onClick={() => removeScheme(scheme.id)}
                className="text-muted-foreground hover:text-foreground rounded-md p-1 transition-colors hover:bg-[var(--surface-2)]"
              >
                <XIcon className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button variant="outline" size="xs" onClick={() => fileInputRef.current?.click()}>
          Import Scheme…
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept={IMPORT_ACCEPT}
          multiple
          hidden
          data-testid="terminal-scheme-file"
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])];
            // Picking the same file again after editing it fires a change event again.
            e.currentTarget.value = "";
            void importFiles(files);
          }}
        />
      </div>
      {status && (
        <p
          role={status.error ? "alert" : "status"}
          className={
            status.error ? "text-destructive text-[10px]" : "text-muted-foreground text-[10px]"
          }
        >
          {status.message}
        </p>
      )}
    </div>
  );
}

/** The scheme's background with its foreground as text and its 16 ANSI colors as swatches. */
function SchemePreview({ scheme }: { scheme: TerminalColorScheme }) {
  const { palette } = scheme;
  return (
    <div
      aria-hidden
      className="border-input flex h-8 shrink-0 items-center gap-2 rounded-md border px-2"
      style={{ backgroundColor: palette.background }}
    >
      <span className="font-mono text-xs" style={{ color: palette.foreground }}>
        Aa
      </span>
      <div className="grid grid-cols-8 gap-0.5">
        {ANSI_COLOR_NAMES.map((name) => (
          <span
            key={name}
            className="size-2 rounded-[2px]"
            style={{ backgroundColor: palette[name] }}
          />
        ))}
      </div>
    </div>
  );
}
