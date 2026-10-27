import { CheckIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { HighlightedLabel } from "@/components/ui/HighlightedLabel";
import { KeyBindingDisplay } from "@/components/ui/key-binding-display";
import { PickerDialog, PickerMessage } from "@/components/ui/picker-dialog";
import { useActionHandler } from "@/hooks/useActionHandler";
import { fuzzyMatch } from "@/lib/fuzzy-match";
import {
  type CommandPaletteMode,
  type QuickPickItem,
  useCommandPaletteStore,
} from "@/store/command-palette";
import type { ActionId } from "@/store/keybindings/action-registry";
import { ACTIONS, isActionId } from "@/store/keybindings/action-registry";
import type { KeyBinding } from "@/store/keybindings/key-combo";
import {
  getBindingsForAction,
  type KeybindingState,
  useKeybindingStore,
} from "@/store/keybindings/keybinding-store";
import { isActionEnabledHere } from "@/store/keybindings/pending-chord";

/** One row of the list: an action in command mode, an item in pick mode. */
interface PaletteRow {
  key: string;
  label: string;
  /** Matched characters of `label`, for highlighting. */
  indices: number[];
  description?: string;
  current?: boolean;
  bindings: readonly KeyBinding[];
}

/**
 * The actions that apply where focus was when the palette opened (see `ActionDef.isEnabled`): the
 * palette takes focus, and gives it back before running the chosen action.
 */
function actionsEnabledAtOpen(): ReadonlySet<ActionId> {
  return new Set(ACTIONS.filter((a) => isActionEnabledHere(a.id)).map((a) => a.id));
}

const NO_ACTIONS: ReadonlySet<ActionId> = new Set();

function commandRows(
  query: string,
  kbState: KeybindingState,
  enabled: ReadonlySet<ActionId>,
): PaletteRow[] {
  const visible = ACTIONS.filter((a) => !a.hidden && enabled.has(a.id));
  const toRow = (action: (typeof visible)[number], indices: number[]): PaletteRow => ({
    key: action.id,
    label: action.label,
    indices,
    bindings: getBindingsForAction(kbState, action.id),
  });
  const q = query.trim();
  if (!q) return visible.map((a) => toRow(a, []));

  const results: Array<{ row: PaletteRow; score: number }> = [];
  for (const action of visible) {
    const match = fuzzyMatch(q, action.label);
    if (match) results.push({ row: toRow(action, match.indices), score: match.score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.map(({ row }) => row);
}

function pickRows(query: string, items: QuickPickItem[]): PaletteRow[] {
  const toRow = (item: QuickPickItem, indices: number[]): PaletteRow => ({
    key: item.id,
    label: item.label,
    indices,
    description: item.description,
    current: item.current,
    bindings: [],
  });
  const q = query.trim();
  if (!q) return items.map((item) => toRow(item, []));

  const results: Array<{ row: PaletteRow; score: number }> = [];
  for (const item of items) {
    const match = fuzzyMatch(q, item.label);
    if (match) {
      results.push({ row: toRow(item, match.indices), score: match.score });
      continue;
    }
    // A description match (a path) ranks below every label match.
    const descriptionMatch = item.description ? fuzzyMatch(q, item.description) : null;
    if (descriptionMatch) {
      results.push({ row: toRow(item, []), score: descriptionMatch.score - 1_000_000 });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.map(({ row }) => row);
}

function placeholderFor(mode: CommandPaletteMode): string {
  return mode.kind === "commands" ? "Run command" : mode.placeholder;
}

/** What the list shows when it has no rows. */
function emptyMessage(mode: CommandPaletteMode, query: string): string | null {
  switch (mode.kind) {
    case "commands":
      return query ? "No matching commands" : null;
    case "pick":
      if (mode.error) return mode.error;
      if (mode.items === null) return "Loading…";
      return query ? "No matching items" : "Nothing to pick";
    case "input":
      return "Press Enter to confirm or Escape to cancel";
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown palette mode: ${String(_exhaustive)}`);
    }
  }
}

/**
 * The command palette: runs app actions, and also hosts the quick picks and text inputs other
 * features request through `requestQuickPick` / `requestTextInput`.
 */
export function CommandPaletteModal() {
  const isOpen = useCommandPaletteStore((s) => s.isOpen);
  const query = useCommandPaletteStore((s) => s.query);
  const mode = useCommandPaletteStore((s) => s.mode);
  const dispatch = useActionHandler();
  const close = useCallback(() => useCommandPaletteStore.getState().close(), []);
  const setQuery = useCallback((q: string) => useCommandPaletteStore.getState().setQuery(q), []);
  const submit = useCallback(
    (value: string) => useCommandPaletteStore.getState().submit(value),
    [],
  );

  const kbState = useKeybindingStore();
  // Taken in the render that opens the palette, before the dialog takes focus.
  const [enabled, setEnabled] = useState(NO_ACTIONS);
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setEnabled(actionsEnabledAtOpen());
  }

  const rows = useMemo(() => {
    if (mode.kind === "commands") return commandRows(query, kbState, enabled);
    if (mode.kind === "pick") return pickRows(query, mode.items ?? []);
    return [];
  }, [mode, query, kbState, enabled]);

  const choose = useCallback(
    ({ key }: PaletteRow) => {
      const store = useCommandPaletteStore.getState();
      if (store.mode.kind !== "commands") {
        store.submit(key);
        return;
      }
      if (!isActionId(key)) return;
      close();
      // Defer dispatch so the dialog closes before the action runs
      // (avoids focus conflicts when actions open other dialogs)
      requestAnimationFrame(() => dispatch(key));
    },
    [close, dispatch],
  );

  const empty = rows.length === 0 ? emptyMessage(mode, query) : null;

  return (
    <PickerDialog
      name="Command Palette"
      isOpen={isOpen}
      onClose={close}
      query={query}
      onQueryChange={setQuery}
      placeholder={placeholderFor(mode)}
      items={rows}
      getKey={(row) => row.key}
      onAccept={choose}
      onSubmitQuery={mode.kind === "input" ? submit : undefined}
      // The input after a pick replaces the list without closing the dialog.
      focusKey={mode.kind}
      itemClassName="py-2"
      emptyState={empty && <PickerMessage>{empty}</PickerMessage>}
      renderItem={(row) => (
        <div className="flex items-center justify-between gap-4">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 truncate text-sm">
              {query.trim() ? (
                <HighlightedLabel text={row.label} indices={row.indices} />
              ) : (
                row.label
              )}
            </span>
            {row.description && (
              <span className="text-muted-foreground truncate text-xs" title={row.description}>
                {row.description}
              </span>
            )}
          </span>
          {row.current && <CheckIcon className="size-3.5 shrink-0" aria-label="Current" />}
          {row.bindings.length > 0 && (
            <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
              {row.bindings.map((binding) => (
                <KeyBindingDisplay key={binding} binding={binding} />
              ))}
            </span>
          )}
        </div>
      )}
    />
  );
}
