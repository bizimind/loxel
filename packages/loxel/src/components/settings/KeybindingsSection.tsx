/**
 * Settings tab for viewing and remapping keybindings.
 * Template selector, searchable binding table, inline key recorder.
 */

import { PencilIcon, RotateCcwIcon, SearchIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KeyComboDisplay } from "@/components/ui/key-combo-display";
import type { ActionCategory, ActionId } from "@/store/keybindings/action-registry";
import { ACTIONS } from "@/store/keybindings/action-registry";
import type { KeyCombo } from "@/store/keybindings/keybinding-schema";
import { TEMPLATES } from "@/store/keybindings/keybinding-schema";
import { useKeybindingStore } from "@/store/keybindings/keybinding-store";

import { KeyRecorder } from "./KeyRecorder";

const CATEGORY_LABELS: Record<ActionCategory, string> = {
  panel: "Panels",
  toggle: "Toggle Sidebar Panels",
  nav: "Navigation",
  sidebar: "Sidebars",
  worktree: "Worktrees",
  tree: "Trees",
  app: "Application",
};

const CATEGORY_ORDER: ActionCategory[] = [
  "panel",
  "toggle",
  "sidebar",
  "nav",
  "worktree",
  "tree",
  "app",
];

export function KeybindingsSection() {
  const activeTemplate = useKeybindingStore((s) => s.activeTemplate);
  const overrides = useKeybindingStore((s) => s.overrides);
  const [search, setSearch] = useState("");
  const [editingAction, setEditingAction] = useState<ActionId | null>(null);

  const filteredActions = useMemo(() => {
    if (!search) return ACTIONS;
    const q = search.toLowerCase();
    return ACTIONS.filter((a) => a.label.toLowerCase().includes(q));
  }, [search]);

  const handleConfirmRemap = useCallback((actionId: ActionId, combos: KeyCombo[]) => {
    useKeybindingStore.getState().setOverride(actionId, combos);
    setEditingAction(null);
  }, []);

  const handleResetOne = useCallback((actionId: ActionId) => {
    useKeybindingStore.getState().removeOverride(actionId);
  }, []);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-foreground text-sm font-medium">Keybindings</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          Customize keyboard shortcuts. Click the edit icon to remap a binding.
        </p>
      </div>

      {/* Search + reset */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <SearchIcon className="text-muted-foreground absolute top-1/2 left-2 size-3 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search keybindings..."
            className="h-7 pl-7 text-xs"
          />
        </div>

        {Object.keys(overrides).length > 0 && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => useKeybindingStore.getState().resetAllOverrides()}
          >
            <RotateCcwIcon className="mr-1 size-3" />
            Reset All
          </Button>
        )}
      </div>

      {/* Binding table grouped by category */}
      <div className="space-y-4">
        {CATEGORY_ORDER.map((category) => {
          const actions = filteredActions.filter((a) => a.category === category);
          if (actions.length === 0) return null;

          return (
            <div key={category}>
              <h4 className="text-muted-foreground mb-2 text-xs font-medium tracking-wider uppercase">
                {CATEGORY_LABELS[category]}
              </h4>
              <div className="divide-border/50 divide-y rounded-md bg-[var(--surface-2)]">
                {actions.map((action) => (
                  <BindingRow
                    key={action.id}
                    actionId={action.id}
                    label={action.label}
                    combos={
                      action.id in overrides
                        ? (overrides[action.id] ?? [])
                        : (TEMPLATES[activeTemplate][action.id] ?? [])
                    }
                    isOverridden={action.id in overrides}
                    isEditing={editingAction === action.id}
                    onEdit={() => setEditingAction(action.id)}
                    onConfirm={(combos) => handleConfirmRemap(action.id, combos)}
                    onCancel={() => setEditingAction(null)}
                    onReset={() => handleResetOne(action.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Binding row
// ---------------------------------------------------------------------------

interface BindingRowProps {
  actionId: ActionId;
  label: string;
  combos: readonly KeyCombo[];
  isOverridden: boolean;
  isEditing: boolean;
  onEdit: () => void;
  onConfirm: (combos: KeyCombo[]) => void;
  onCancel: () => void;
  onReset: () => void;
}

function BindingRow({
  actionId,
  label,
  combos,
  isOverridden,
  isEditing,
  onEdit,
  onConfirm,
  onCancel,
  onReset,
}: BindingRowProps) {
  if (isEditing) {
    return (
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-foreground w-[180px] shrink-0 text-xs">{label}</span>
        <KeyRecorder actionId={actionId} onConfirm={onConfirm} onCancel={onCancel} />
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-2 px-3 py-1.5">
      <span className="text-foreground w-[180px] shrink-0 text-xs">{label}</span>

      <div className="flex flex-1 flex-wrap gap-1">
        {combos.map((combo) => (
          <kbd
            key={combo as string}
            className="bg-muted border-border text-muted-foreground flex items-center rounded border px-1.5 py-0.5 text-[10px]"
          >
            <KeyComboDisplay combo={combo} />
          </kbd>
        ))}
        {combos.length === 0 && (
          <span className="text-muted-foreground text-xs italic">unbound</span>
        )}
      </div>

      <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          onClick={onEdit}
          className="text-muted-foreground hover:text-foreground rounded p-1 transition-colors"
          title="Edit keybinding"
        >
          <PencilIcon className="size-3" />
        </button>
        {isOverridden && (
          <button
            onClick={onReset}
            className="text-muted-foreground hover:text-foreground rounded p-1 transition-colors"
            title="Reset to default"
          >
            <RotateCcwIcon className="size-3" />
          </button>
        )}
      </div>
    </div>
  );
}
