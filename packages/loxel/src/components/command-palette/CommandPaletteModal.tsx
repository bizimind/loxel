import { useCallback, useMemo } from "react";

import { HighlightedLabel } from "@/components/ui/HighlightedLabel";
import { KeyBindingDisplay } from "@/components/ui/key-binding-display";
import { QuickPick, QuickPickMessage } from "@/components/ui/quick-pick";
import { useActionHandler } from "@/hooks/useActionHandler";
import { fuzzyMatch } from "@/lib/fuzzy-match";
import { useCommandPaletteStore } from "@/store/command-palette";
import type { ActionDef } from "@/store/keybindings/action-registry";
import { ACTIONS } from "@/store/keybindings/action-registry";
import { getBindingsForAction, useKeybindingStore } from "@/store/keybindings/keybinding-store";

interface CommandMatch {
  action: ActionDef;
  indices: number[];
}

export function CommandPaletteModal() {
  const isOpen = useCommandPaletteStore((s) => s.isOpen);
  const query = useCommandPaletteStore((s) => s.query);
  const dispatch = useActionHandler();
  const close = useCallback(() => useCommandPaletteStore.getState().close(), []);
  const setQuery = useCallback((q: string) => useCommandPaletteStore.getState().setQuery(q), []);

  const kbState = useKeybindingStore();

  const filtered = useMemo((): CommandMatch[] => {
    const visible = ACTIONS.filter((a) => !a.hidden);
    const q = query.trim();
    if (!q) return visible.map((a) => ({ action: a, indices: [] }));

    const results: Array<CommandMatch & { score: number }> = [];
    for (const action of visible) {
      const match = fuzzyMatch(q, action.label);
      if (match) results.push({ action, indices: match.indices, score: match.score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.map(({ action, indices }) => ({ action, indices }));
  }, [query]);

  const runAction = useCallback(
    ({ action }: CommandMatch) => {
      close();
      // Defer dispatch so the dialog closes before the action runs
      // (avoids focus conflicts when actions open other dialogs)
      requestAnimationFrame(() => dispatch(action.id));
    },
    [close, dispatch],
  );

  return (
    <QuickPick
      name="Command Palette"
      isOpen={isOpen}
      onClose={close}
      query={query}
      onQueryChange={setQuery}
      placeholder="Run command"
      items={filtered}
      getKey={({ action }) => action.id}
      onAccept={runAction}
      itemClassName="py-2"
      emptyState={query && <QuickPickMessage>No matching commands</QuickPickMessage>}
      renderItem={({ action, indices }) => {
        const bindings = getBindingsForAction(kbState, action.id);
        return (
          <div className="flex items-center justify-between gap-4">
            <span className="truncate text-sm">
              {query.trim() ? (
                <HighlightedLabel text={action.label} indices={indices} />
              ) : (
                action.label
              )}
            </span>
            {bindings.length > 0 && (
              <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
                {bindings.map((binding) => (
                  <KeyBindingDisplay key={binding} binding={binding} />
                ))}
              </span>
            )}
          </div>
        );
      }}
    />
  );
}
