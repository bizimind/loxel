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

export function FontsSection() {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-foreground text-sm font-medium">Fonts</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          Use fonts installed on this computer. Settings keep only the font&apos;s name: where it
          isn&apos;t installed, Loxel shows its bundled font instead.
        </p>
      </div>
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
    </div>
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
  const codeFamily = useSettingsStore((s) => s.fonts.code.family);
  const codeSize = useSettingsStore((s) => s.fonts.code.size);
  const updateFont = useSettingsStore((s) => s.updateFont);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [fonts, setFonts] = useState<LocalFontsResult | null>(null);

  // The terminal's unset family and size follow the code font.
  const follows = kind === "terminal";
  const defaultLabel = follows ? "Same as code font" : `${BUNDLED_FONT_FAMILY[kind]} (bundled)`;
  const installed = useMemo(() => family === null || isFontFamilyAvailable(family), [family]);
  const fallbackName = follows && codeFamily ? codeFamily : BUNDLED_FONT_FAMILY[kind];

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
      <p className="text-muted-foreground text-[10px]">{description}</p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={openPicker}
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
          size={size}
          placeholder={follows ? String(codeSize) : undefined}
          onCommit={(next) => updateFont(kind, { size: next })}
        />
      </div>
      {!installed && (
        <p className="text-warning text-[10px]">
          {family} isn&apos;t installed on this computer. Loxel shows {fallbackName} instead.
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
  size,
  placeholder,
  onCommit,
}: {
  kind: FontKind;
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
    } else {
      setLocal(size === null ? "" : String(size));
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        aria-label="Font size"
        value={local}
        placeholder={placeholder}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
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
