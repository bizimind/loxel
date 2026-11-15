import { XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import {
  BUNDLED_FONT_FAMILY,
  FONT_SIZE_LIMITS,
  type FontKind,
  GENERIC_FAMILY,
  quoteFontFamily,
} from "@/lib/font-settings";
import {
  isFontFamilyAvailable,
  type LocalFontsResult,
  queryLocalFontFamilies,
} from "@/lib/local-fonts";
import { useSettingsStore } from "@/store/settings-store";

import { FontPicker } from "./FontPicker";

/** The code, terminal and markdown font rows of Settings > Appearance. */
export function FontSettings() {
  return (
    <>
      <FontRow
        kind="code"
        label="Code Font"
        description="Code editors, diffs and markdown code blocks."
      />
      <FontRow
        kind="terminal"
        label="Terminal Font"
        description="Follows the code font until set."
      />
      <FontRow kind="prose" label="Markdown Font" description="Markdown text and headings." />
    </>
  );
}

function FontRow({
  kind,
  label,
  description,
}: {
  kind: FontKind;
  label: string;
  description: string;
}) {
  const family = useSettingsStore((s) => s.fonts[kind].family);
  const size = useSettingsStore((s) => s.fonts[kind].size);
  const codeSize = useSettingsStore((s) => s.fonts.code.size);
  const updateFont = useSettingsStore((s) => s.updateFont);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [fonts, setFonts] = useState<LocalFontsResult | null>(null);

  // The terminal's unset family and size follow the code font.
  const follows = kind === "terminal";
  const defaultLabel = follows ? "Same as code font" : `${BUNDLED_FONT_FAMILY[kind]} (bundled)`;
  const installed = useMemo(() => family === null || isFontFamilyAvailable(family), [family]);

  const openPicker = useCallback(() => {
    setPickerOpen(true);
    // Called from the click: outside Loxel the browser asks for the permission only on a gesture.
    void queryLocalFontFamilies().then(setFonts);
  }, []);

  const pick = useCallback(
    (picked: string | null) => updateFont(kind, { family: picked }),
    [kind, updateFont],
  );

  return (
    <div className="space-y-1.5">
      <label className="text-muted-foreground text-xs">{label}</label>
      <p className="text-muted-foreground text-[10px] not-dark:text-[12px]">{description}</p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={openPicker}
          aria-label={`${label}: ${family ?? defaultLabel}`}
          className="border-input flex h-8 w-64 items-center truncate rounded-md border bg-[var(--surface-2)] px-3 text-left text-xs shadow-sm"
          style={
            family ? { fontFamily: `${quoteFontFamily(family)}, ${GENERIC_FAMILY[kind]}` } : {}
          }
        >
          {family ?? defaultLabel}
        </button>
        {family !== null && (
          <button
            type="button"
            aria-label={`Reset ${label.toLowerCase()}`}
            title="Reset to default"
            onClick={() => pick(null)}
            className="text-muted-foreground hover:text-foreground rounded-md p-1 transition-colors hover:bg-[var(--surface-2)]"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
        <FontSizeInput
          kind={kind}
          label={`${label} size`}
          size={size}
          placeholder={follows ? String(codeSize) : undefined}
          onCommit={(next) => updateFont(kind, { size: next })}
        />
      </div>
      {!installed && (
        <p className="text-warning text-[10px]">
          {family} isn&apos;t installed on this computer. Loxel shows {BUNDLED_FONT_FAMILY[kind]}{" "}
          instead.
        </p>
      )}
      <FontPicker
        kind={kind}
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        fonts={fonts}
        value={family}
        defaultLabel={defaultLabel}
        onPick={pick}
      />
    </div>
  );
}

/**
 * A font size in pixels, committed on blur or Enter. With a placeholder, an empty field commits
 * null: the size follows the one the placeholder shows.
 */
function FontSizeInput({
  kind,
  label,
  size,
  placeholder,
  onCommit,
}: {
  kind: FontKind;
  label: string;
  size: number | null;
  placeholder?: string;
  onCommit: (size: number | null) => void;
}) {
  const { min, max } = FONT_SIZE_LIMITS[kind];
  const [local, setLocal] = useState(size === null ? "" : String(size));

  // Sync when the store changes externally (e.g. cancel/revert).
  useEffect(() => setLocal(size === null ? "" : String(size)), [size]);

  const commit = () => {
    if (local.trim() === "" && placeholder !== undefined) {
      onCommit(null);
      return;
    }
    const value = Number.parseInt(local, 10);
    if (Number.isFinite(value) && value >= min && value <= max) {
      onCommit(value);
      // Shows what was saved, such as 13 for "13.5", even when the size did not change.
      setLocal(String(value));
    } else {
      setLocal(size === null ? "" : String(size));
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        aria-label={label}
        value={local}
        placeholder={placeholder}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          // Blurring commits, once.
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        min={min}
        max={max}
        className="h-8 w-16 text-xs"
      />
      <span className="text-muted-foreground text-[10px]">
        px ({min}–{max})
      </span>
    </div>
  );
}
