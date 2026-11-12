import { RotateCcwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toHexColor } from "@/lib/css-color";
import { frontendLog } from "@/lib/frontend-logger";
import {
  isThemeColor,
  allThemes,
  type LoxelTheme,
  MAX_THEME_NAME_LENGTH,
  SYNTAX_ROLES,
  TERMINAL_COLOR_NAMES,
  type TerminalColorName,
  terminalColors,
  UI_TOKEN_GROUPS,
  uiTokensFor,
} from "@/lib/loxel-theme";
import { baseSyntaxColors } from "@/lib/syntax-theme";
import {
  MAX_SCHEME_FILE_BYTES,
  parseTerminalSchemeFile,
  SchemeImportError,
} from "@/lib/terminal-scheme-import";
import { readThemeTokens } from "@/lib/theme-stylesheet";
import { useSettingsStore } from "@/store/settings-store";

import { type ThemeStatus, ThemeStatusMessage } from "./ThemeStatusMessage";

const log = frontendLog.child("ui");

const TERMINAL_LABELS: Record<TerminalColorName, string> = {
  foreground: "Foreground",
  cursor: "Cursor",
  selection: "Selection",
  black: "Black",
  red: "Red",
  green: "Green",
  yellow: "Yellow",
  blue: "Blue",
  magenta: "Magenta",
  cyan: "Cyan",
  white: "White",
  brightBlack: "Bright black",
  brightRed: "Bright red",
  brightGreen: "Bright green",
  brightYellow: "Bright yellow",
  brightBlue: "Bright blue",
  brightMagenta: "Bright magenta",
  brightCyan: "Bright cyan",
  brightWhite: "Bright white",
};

/** `map` without `key`, so the base theme's color shows through again. */
function without<T extends Record<string, unknown>>(map: T, key: string): T {
  const { [key]: _, ...rest } = map;
  return rest as T;
}

/**
 * Edit a custom theme's name and colors. Every change applies at once: to the window when the
 * theme is in use, and to the theme's previews.
 */
export function ThemeEditor({ theme, onClose }: { theme: LoxelTheme; onClose: () => void }) {
  const updateTheme = useSettingsStore((s) => s.updateTheme);
  const themes = useSettingsStore((s) => s.themes);
  const update = (patch: Partial<Omit<LoxelTheme, "id" | "base">>) => updateTheme(theme.id, patch);
  const tokens = useMemo(() => uiTokensFor(theme.base), [theme.base]);
  const tokenNames = useMemo(() => tokens.map((t) => t.name), [tokens]);
  const uiValues = useMemo(() => readThemeTokens(theme, tokenNames), [theme, tokenNames]);
  const terminal = terminalColors(theme);
  const syntax = { ...baseSyntaxColors(theme.base), ...theme.syntax };
  const schemeInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<ThemeStatus | null>(null);

  const importScheme = async (file: File) => {
    try {
      if (file.size > MAX_SCHEME_FILE_BYTES) {
        throw new SchemeImportError(`${file.name} is too large to be a color scheme.`);
      }
      const { schemes } = parseTerminalSchemeFile(file.name, await file.text());
      // An iTerm2 profile with separate light and dark colors gives one scheme per mode.
      const modeSuffix = theme.base === "dark" ? " (Dark)" : " (Light)";
      const scheme = schemes.find((s) => s.name.endsWith(modeSuffix)) ?? schemes[0];
      if (!scheme) return;
      update({ terminal: { ...theme.terminal, ...scheme.ansi } });
      const more = schemes.length > 1 ? `, one of the ${schemes.length} in the file` : "";
      setStatus({ error: false, message: `Took the ANSI colors of ${scheme.name}${more}.` });
    } catch (error) {
      if (error instanceof SchemeImportError) {
        setStatus({ error: true, message: error.message });
        return;
      }
      log.warn("Could not read a terminal color scheme file", { error });
      setStatus({ error: true, message: `${file.name} could not be read.` });
    }
  };

  return (
    <section
      aria-label={`Edit ${theme.name}`}
      className="border-border mt-3 space-y-3 rounded-md border p-3"
    >
      <div className="flex items-center gap-2">
        <label htmlFor="theme-editor-name" className="text-muted-foreground text-xs">
          Name
        </label>
        <NameInput
          name={theme.name}
          taken={(name) =>
            allThemes(themes).some(
              (t) => t.id !== theme.id && t.base === theme.base && t.name === name,
            )
          }
          onCommit={(name) => update({ name })}
        />
        <Button variant="outline" size="xs" className="ml-auto" onClick={onClose}>
          Done
        </Button>
      </div>

      {UI_TOKEN_GROUPS.map((group) => (
        <ColorGroup key={group} title={group} open={group === "Surfaces"}>
          {tokens
            .filter((t) => t.group === group)
            .map((t) => (
              <ColorRow
                key={t.name}
                label={t.label}
                value={uiValues[t.name] ?? ""}
                overridden={t.name in theme.colors}
                onChange={(color) => update({ colors: { ...theme.colors, [t.name]: color } })}
                onReset={() => update({ colors: without(theme.colors, t.name) })}
              />
            ))}
        </ColorGroup>
      ))}

      <ColorGroup title="Terminal">
        <p className="text-muted-foreground text-[10px] not-dark:text-[12px]">
          The terminal&apos;s background is the editor surface. Take the 16 ANSI colors from an
          iTerm2 (.itermcolors), Windows Terminal or VS Code file.
        </p>
        <div>
          <Button variant="outline" size="xs" onClick={() => schemeInputRef.current?.click()}>
            Import ANSI Colors…
          </Button>
          <input
            ref={schemeInputRef}
            type="file"
            accept=".itermcolors,.json,.jsonc,.plist,.xml"
            hidden
            data-testid="terminal-scheme-file"
            onChange={(e) => {
              const [file] = e.currentTarget.files ?? [];
              e.currentTarget.value = "";
              if (file) void importScheme(file);
            }}
          />
        </div>
        {status && <ThemeStatusMessage status={status} />}
        {TERMINAL_COLOR_NAMES.map((name) => (
          <ColorRow
            key={name}
            label={TERMINAL_LABELS[name]}
            value={terminal[name]}
            overridden={name in theme.terminal}
            onChange={(color) => update({ terminal: { ...theme.terminal, [name]: color } })}
            onReset={() => update({ terminal: without(theme.terminal, name) })}
          />
        ))}
      </ColorGroup>

      <ColorGroup title="Syntax">
        {SYNTAX_ROLES.map((r) => (
          <ColorRow
            key={r.id}
            label={r.label}
            value={syntax[r.id] ?? ""}
            overridden={r.id in theme.syntax}
            onChange={(color) => update({ syntax: { ...theme.syntax, [r.id]: color } })}
            onReset={() => update({ syntax: without(theme.syntax, r.id) })}
          />
        ))}
      </ColorGroup>
    </section>
  );
}

function ColorGroup({
  title,
  open,
  children,
}: {
  title: string;
  open?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={open} className="group">
      <summary className="text-foreground cursor-pointer text-xs font-medium select-none">
        {title}
      </summary>
      <div className="space-y-1 pt-1.5 pl-3">{children}</div>
    </details>
  );
}

/**
 * A theme's name, committed on blur or Enter. An empty name, or one another theme of the mode has,
 * keeps the old one: an import replaces the theme with its name and mode.
 */
function NameInput({
  name,
  taken,
  onCommit,
}: {
  name: string;
  taken: (name: string) => boolean;
  onCommit: (name: string) => void;
}) {
  const [local, setLocal] = useState(name);
  useEffect(() => setLocal(name), [name]);
  const commit = () => {
    const next = local.trim();
    if (next && next !== name && !taken(next)) onCommit(next);
    else setLocal(name);
  };
  return (
    <Input
      id="theme-editor-name"
      value={local}
      maxLength={MAX_THEME_NAME_LENGTH}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      className="h-7 w-56 text-xs"
    />
  );
}

/**
 * One color: a swatch that opens the system color picker, and the value as text, which takes any
 * CSS color a theme may hold. The picker has no alpha, so a translucent color keeps its alpha.
 */
function ColorRow({
  label,
  value,
  overridden,
  onChange,
  onReset,
}: {
  label: string;
  value: string;
  overridden: boolean;
  onChange: (color: string) => void;
  onReset: () => void;
}) {
  const hex = toHexColor(value);
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const next = text.trim();
    if (next !== value && isThemeColor(next)) onChange(next);
    else setText(value);
  };
  // A fully transparent color would stay invisible whatever is picked: picking makes it opaque.
  const alpha = /^#[\da-f]{8}$/i.test(hex) && !hex.endsWith("00") ? hex.slice(7) : "";
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        aria-label={label}
        value={/^#[\da-f]{6}/i.test(hex) ? hex.slice(0, 7) : "#000000"}
        onChange={(e) => onChange(`${e.target.value}${alpha}`)}
        className="size-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
      />
      <Input
        aria-label={`${label} value`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="h-6 w-40 font-mono text-[11px]"
      />
      <span className={overridden ? "text-foreground text-xs" : "text-muted-foreground text-xs"}>
        {label}
      </span>
      {overridden && (
        <button
          type="button"
          aria-label={`Reset ${label}`}
          title="Reset to the base theme's color"
          onClick={onReset}
          className="text-muted-foreground hover:text-foreground rounded-md p-0.5 transition-colors hover:bg-[var(--surface-2)]"
        >
          <RotateCcwIcon className="size-3" />
        </button>
      )}
    </div>
  );
}
