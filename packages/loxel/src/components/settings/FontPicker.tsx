import { CheckIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { PickerDialog, PickerMessage } from "@/components/ui/picker-dialog";
import { Switch } from "@/components/ui/switch";
import { type FontKind, GENERIC_FAMILY, quoteFontFamily } from "@/lib/font-settings";
import { isMonospaceFamily, type LocalFontsResult } from "@/lib/local-fonts";

/** Rows past this many are left out until the query narrows the list; each row loads its font. */
const MAX_ROWS = 200;

type FontPickerItem =
  | { type: "default"; label: string }
  | { type: "family"; family: string }
  /** The typed name, for a font the list does not show. */
  | { type: "typed"; family: string };

interface FontPickerProps {
  kind: FontKind;
  isOpen: boolean;
  onClose: () => void;
  /** The installed fonts, or null while they load. */
  fonts: LocalFontsResult | null;
  /** The family set now; null for the default. */
  value: string | null;
  defaultLabel: string;
  onPick: (family: string | null) => void;
}

/**
 * A searchable list of the installed fonts, each row in its own font. Code and terminal pickers
 * show monospace fonts unless "Show all fonts" is on, and then list them first. A typed name can be
 * picked too, which is all there is where the browser cannot list fonts.
 */
export function FontPicker({
  kind,
  isOpen,
  onClose,
  fonts,
  value,
  defaultLabel,
  onPick,
}: FontPickerProps) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const monospaceKind = kind !== "prose";

  const families = useMemo(() => {
    if (fonts?.status !== "ok") return [];
    if (!monospaceKind) return fonts.families;
    const monospace = fonts.families.filter((family) => isMonospaceFamily(family));
    if (!showAll) return monospace;
    const rest = fonts.families.filter((family) => !isMonospaceFamily(family));
    return [...monospace, ...rest];
  }, [fonts, monospaceKind, showAll]);

  const trimmed = query.trim();
  const matches = useMemo(() => {
    const needle = trimmed.toLowerCase();
    return needle ? families.filter((family) => family.toLowerCase().includes(needle)) : families;
  }, [families, trimmed]);

  const items = useMemo((): FontPickerItem[] => {
    const rows: FontPickerItem[] = matches
      .slice(0, MAX_ROWS)
      .map((family) => ({ type: "family", family }));
    if (!trimmed) return [{ type: "default", label: defaultLabel }, ...rows];
    const exact = matches.some((family) => family.toLowerCase() === trimmed.toLowerCase());
    return exact ? rows : [...rows, { type: "typed", family: trimmed }];
  }, [matches, trimmed, defaultLabel]);

  const close = () => {
    setQuery("");
    onClose();
  };

  const accept = (item: FontPickerItem) => {
    onPick(item.type === "default" ? null : item.family);
    close();
  };

  const previewFont = (family: string) => `${quoteFontFamily(family)}, ${GENERIC_FAMILY[kind]}`;

  return (
    <PickerDialog
      name="Font Picker"
      isOpen={isOpen}
      onClose={close}
      query={query}
      onQueryChange={setQuery}
      placeholder="Search installed fonts, or type a font name"
      items={items}
      onAccept={accept}
      getKey={(item) => `${item.type}:${item.type === "default" ? "" : item.family}`}
      focusKey={String(showAll)}
      itemClassName="py-1.5"
      emptyState={<PickerMessage>No installed font matches.</PickerMessage>}
      renderItem={(item) => {
        const selected = item.type === "default" ? value === null : item.family === value;
        return (
          <div className="flex items-center gap-2">
            {item.type === "default" && <span className="text-sm">{item.label}</span>}
            {item.type === "family" && (
              <span className="truncate text-base" style={{ fontFamily: previewFont(item.family) }}>
                {item.family}
              </span>
            )}
            {item.type === "typed" && (
              <span className="truncate text-sm">
                Use <span style={{ fontFamily: previewFont(item.family) }}>{item.family}</span>
              </span>
            )}
            {selected && <CheckIcon className="ml-auto size-3.5 shrink-0" />}
          </div>
        );
      }}
      footer={
        <div className="border-border text-muted-foreground flex items-center gap-3 border-t px-3 py-2 text-[11px]">
          <span className="min-w-0 flex-1">
            {fonts === null
              ? "Loading installed fonts…"
              : fonts.status === "unavailable"
                ? "Installed fonts can't be listed here. Type a font's name to use it."
                : matches.length > MAX_ROWS
                  ? `Showing ${MAX_ROWS} of ${matches.length} fonts. Type to narrow the list.`
                  : null}
          </span>
          {monospaceKind && fonts?.status === "ok" && (
            <label className="flex shrink-0 items-center gap-2">
              Show all fonts
              <Switch checked={showAll} onCheckedChange={setShowAll} />
            </label>
          )}
        </div>
      }
    />
  );
}
