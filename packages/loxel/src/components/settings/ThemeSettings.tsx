import { CopyIcon, DownloadIcon, PencilIcon, XIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { toHexColor } from "@/lib/css-color";
import { downloadTextFile } from "@/lib/download-file";
import { frontendLog } from "@/lib/frontend-logger";
import {
  allThemes,
  ANSI_COLOR_NAMES,
  isBuiltinTheme,
  type LoxelTheme,
  resolveTheme,
  terminalColors,
  type ThemeBase,
} from "@/lib/loxel-theme";
import { baseSyntaxColors } from "@/lib/syntax-theme";
import {
  MAX_THEME_FILE_BYTES,
  parseThemeFile,
  serializeTheme,
  ThemeFileError,
  themeFileName,
} from "@/lib/theme-file";
import { readThemeTokens } from "@/lib/theme-stylesheet";
import { useSettingsStore } from "@/store/settings-store";

import { ThemeEditor } from "./ThemeEditor";
import { type ThemeStatus, ThemeStatusMessage } from "./ThemeStatusMessage";

const log = frontendLog.child("ui");

const MODE_ROWS: { base: ThemeBase; label: string }[] = [
  { base: "light", label: "Light mode" },
  { base: "dark", label: "Dark mode" },
];

const BASE_LABELS: Record<ThemeBase, string> = { light: "Light", dark: "Dark" };

/** The color theme rows of Settings > Appearance: a theme per mode, and the themes to manage. */
export function ThemeSettings() {
  const themes = useSettingsStore((s) => s.themes);
  const setModeTheme = useSettingsStore((s) => s.setModeTheme);
  const importTheme = useSettingsStore((s) => s.importTheme);
  const duplicateTheme = useSettingsStore((s) => s.duplicateTheme);
  const removeTheme = useSettingsStore((s) => s.removeTheme);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<ThemeStatus | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = themes.custom.find((t) => t.id === editingId) ?? null;

  const importFile = async (file: File) => {
    try {
      if (file.size > MAX_THEME_FILE_BYTES) {
        throw new ThemeFileError(`${file.name} is too large to be a Loxel theme.`);
      }
      const { theme, ignored } = parseThemeFile(file.name, await file.text());
      importTheme(theme);
      const skipped =
        ignored.length > 0
          ? ` It ignored what this Loxel does not know: ${ignored.join(", ")}.`
          : "";
      setStatus({
        error: false,
        message: `Imported ${theme.name}, now the ${theme.base} mode theme.${skipped}`,
      });
    } catch (error) {
      if (error instanceof ThemeFileError) {
        setStatus({ error: true, message: error.message });
        return;
      }
      // The file went away or became unreadable after it was picked.
      log.warn("Could not read a theme file", { error });
      setStatus({ error: true, message: `${file.name} could not be read.` });
    }
  };

  const duplicate = (theme: LoxelTheme) => {
    const id = duplicateTheme(theme.id);
    if (id) setEditingId(id);
    setStatus(null);
  };

  return (
    <div className="space-y-1.5">
      <label className="text-muted-foreground text-xs">Color Themes</label>
      <p className="text-muted-foreground text-[10px] not-dark:text-[12px]">
        The colors of Loxel, its terminals and code in each mode. Duplicate a theme to change its
        colors, and export it as a theme.json file to share or back it up.
      </p>
      <div className="grid grid-cols-[auto_auto_auto] items-center justify-start gap-x-3 gap-y-1.5 pt-0.5">
        {MODE_ROWS.map(({ base, label }) => {
          const id = `theme-${base}`;
          const current = resolveTheme(themes, base === "dark");
          return (
            <div key={base} className="contents">
              <label htmlFor={id} className="text-foreground text-xs">
                {label}
              </label>
              <select
                id={id}
                value={current.id}
                onChange={(e) => setModeTheme(base, e.target.value)}
                className="border-input text-foreground block h-8 w-48 rounded-md border bg-[var(--surface-2)] px-2 text-xs shadow-sm"
              >
                {allThemes(themes)
                  .filter((t) => t.base === base)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
              <ThemePreview theme={current} />
            </div>
          );
        })}
      </div>

      <ul aria-label="Color themes" className="space-y-1 pt-2">
        {allThemes(themes).map((theme) => {
          const builtin = isBuiltinTheme(theme.id);
          return (
            <li key={theme.id} className="flex items-center gap-2">
              <ThemePreview theme={theme} />
              <span className="text-foreground truncate text-xs">{theme.name}</span>
              <span className="text-muted-foreground text-[10px]">{BASE_LABELS[theme.base]}</span>
              <span className="ml-auto flex items-center">
                {!builtin && (
                  <IconButton label={`Edit ${theme.name}`} onClick={() => setEditingId(theme.id)}>
                    <PencilIcon className="size-3.5" />
                  </IconButton>
                )}
                <IconButton label={`Duplicate ${theme.name}`} onClick={() => duplicate(theme)}>
                  <CopyIcon className="size-3.5" />
                </IconButton>
                <IconButton
                  label={`Export ${theme.name}`}
                  onClick={() =>
                    downloadTextFile(
                      themeFileName(theme),
                      serializeTheme(theme),
                      "application/json",
                    )
                  }
                >
                  <DownloadIcon className="size-3.5" />
                </IconButton>
                {!builtin && (
                  <IconButton
                    label={`Remove ${theme.name}`}
                    onClick={() => {
                      if (editingId === theme.id) setEditingId(null);
                      removeTheme(theme.id);
                    }}
                  >
                    <XIcon className="size-3.5" />
                  </IconButton>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-2 pt-1">
        <Button variant="outline" size="xs" onClick={() => fileInputRef.current?.click()}>
          Import Theme…
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          hidden
          data-testid="theme-file"
          onChange={(e) => {
            const [file] = e.currentTarget.files ?? [];
            // Picking the same file again after editing it fires a change event again.
            e.currentTarget.value = "";
            if (file) void importFile(file);
          }}
        />
      </div>
      {status && <ThemeStatusMessage status={status} />}

      {editing && <ThemeEditor theme={editing} onClose={() => setEditingId(null)} />}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="text-muted-foreground hover:text-foreground rounded-md p-1 transition-colors hover:bg-[var(--surface-2)]"
    >
      {children}
    </button>
  );
}

const PREVIEW_TOKENS = ["editor-surface", "foreground", "card", "button-primary"] as const;
const PREVIEW_SYNTAX = ["keyword", "string", "function", "comment"] as const;

/**
 * A theme in miniature: its bar color beside its editor surface, with text, the accent, a few
 * syntax colors and the terminal's ANSI colors on it.
 */
function ThemePreview({ theme }: { theme: LoxelTheme }) {
  const tokens = useMemo(() => readThemeTokens(theme, PREVIEW_TOKENS), [theme]);
  const syntax = { ...baseSyntaxColors(theme.base), ...theme.syntax };
  const terminal = terminalColors(theme);
  const color = (name: (typeof PREVIEW_TOKENS)[number]) => toHexColor(tokens[name] ?? "");
  return (
    <div
      aria-hidden
      className="border-input flex h-8 w-44 shrink-0 overflow-hidden rounded-md border"
      style={{ backgroundColor: color("editor-surface") }}
    >
      <span className="w-2 shrink-0" style={{ backgroundColor: color("card") }} />
      <span className="flex items-center gap-1.5 px-2">
        <span className="font-mono text-xs" style={{ color: color("foreground") }}>
          Aa
        </span>
        <span className="flex gap-0.5">
          {PREVIEW_SYNTAX.map((role) => (
            <span key={role} className="h-3 w-1" style={{ backgroundColor: syntax[role] }} />
          ))}
        </span>
        <span
          className="size-2 rounded-full"
          style={{ backgroundColor: color("button-primary") }}
        />
        <span className="grid grid-cols-8 gap-0.5">
          {ANSI_COLOR_NAMES.map((name) => (
            <span
              key={name}
              className="size-1.5 rounded-[1px]"
              style={{ backgroundColor: terminal[name] }}
            />
          ))}
        </span>
      </span>
    </div>
  );
}
