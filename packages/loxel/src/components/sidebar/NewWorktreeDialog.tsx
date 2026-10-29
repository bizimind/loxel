import { useRef, useState } from "react";

import type { WorktreeEntry } from "@/api/git-models";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { useWorktreeStore } from "@/store/worktrees";

import { worktreeLabel, worktreeNameFromTitle } from "./worktree-labels";

/** A name typed into the name field: lowercase, whitespace as dashes (as git refs need). */
function normalizeName(value: string): string {
  return value.toLowerCase().replace(/\s/g, "-");
}

/**
 * Creates a worktree: a title (when the project's worktrees have metadata) and a name, which
 * follows the title until it is edited directly. With `parent`, the worktree is nested under it.
 * A branch that already exists is resolved here too.
 */
export function NewWorktreeDialog({
  projectPath,
  parent,
  titles,
  onClose,
}: {
  projectPath: string;
  parent?: WorktreeEntry;
  /** Whether titles can be stored: they are worktree metadata, like nesting */
  titles: boolean;
  onClose: () => void;
}) {
  const createWorktree = useWorktreeStore((s) => s.createWorktree);
  const confirmCreateWorktree = useWorktreeStore((s) => s.confirmCreateWorktree);
  const dismissPendingPlan = useWorktreeStore((s) => s.dismissPendingPlan);
  const conflict = useWorktreeStore((s) =>
    s.pendingAddPlan?.projectPath === projectPath &&
    s.pendingAddPlan.branchConflict?.kind === "exists"
      ? s.pendingAddPlan
      : null,
  );

  const [title, setTitle] = useState("");
  const [name, setName] = useState("");
  /** Set once the name is typed into directly; clearing it follows the title again. */
  const [nameEdited, setNameEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Set when the dialog is closed while a create is still in flight. */
  const abandoned = useRef(false);

  const cancel = () => {
    if (busy) abandoned.current = true;
    if (conflict) dismissPendingPlan();
    onClose();
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      // A branch conflict keeps the dialog open to ask how to resolve it.
      const pending = useWorktreeStore.getState().pendingAddPlan;
      const conflicted =
        pending?.projectPath === projectPath && pending.branchConflict?.kind === "exists";
      // Closed meanwhile: nobody is left to answer the conflict, and its plan would take over
      // the next New worktree dialog.
      if (abandoned.current) {
        if (conflicted) dismissPendingPlan();
        return;
      }
      if (!conflicted) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create worktree");
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const trimmedName = name.trim();
    if (!trimmedName || busy) return;
    const trimmedTitle = title.trim();
    // A title that only repeats the name adds nothing.
    const savedTitle =
      titles && trimmedTitle && trimmedTitle !== trimmedName ? trimmedTitle : undefined;
    void run(() =>
      createWorktree(projectPath, trimmedName, { parentPath: parent?.path, title: savedTitle }),
    );
  };

  const fieldClass =
    "bg-background border-border text-foreground placeholder:text-muted-foreground w-full rounded border px-2 py-1.5 text-xs outline-none focus:border-ring";

  return (
    <DialogShell open onCancel={cancel} className="w-[26rem]">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col gap-3 px-4 pt-4 pb-2">
          <div>
            <h3 className="text-foreground text-sm font-medium">New worktree</h3>
            <p className="text-muted-foreground mt-1 text-xs">
              {parent ? (
                <>
                  Nested under{" "}
                  <span className="text-foreground font-medium">{worktreeLabel(parent)}</span>
                </>
              ) : (
                "At the top level"
              )}
            </p>
          </div>

          {titles && (
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground text-[11px]">Title</span>
              <input
                autoFocus
                value={title}
                disabled={conflict !== null}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (!nameEdited) setName(worktreeNameFromTitle(e.target.value));
                  setError(null);
                }}
                placeholder="What this worktree is for"
                className={fieldClass}
              />
            </label>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground text-[11px]">Name</span>
            <input
              autoFocus={!titles}
              value={name}
              disabled={conflict !== null}
              onChange={(e) => {
                const value = normalizeName(e.target.value);
                setName(value);
                setNameEdited(value !== "");
                setError(null);
              }}
              placeholder="worktree-name"
              className={`${fieldClass} font-mono`}
            />
            <span className="text-muted-foreground text-[10px]">
              {titles
                ? "The worktree's directory and branch. Follows the title until you edit it."
                : "The worktree's directory and branch. Enable worktree nesting to give worktrees titles."}
            </span>
          </label>

          {conflict && (
            <div className="border-warning/20 bg-warning/5 rounded-md border p-2.5">
              <p className="text-warning text-[11px] font-medium">
                Branch &ldquo;{conflict.branch}&rdquo; already exists.
              </p>
            </div>
          )}

          {error && <div className="text-destructive text-[10px]">{error}</div>}
        </div>

        <div className="flex flex-col gap-1.5 px-4 py-3">
          {conflict ? (
            <>
              <Button
                type="button"
                variant="default"
                size="xs"
                className="w-full"
                disabled={busy}
                onClick={() => void run(() => confirmCreateWorktree("use-existing"))}
              >
                Use existing branch
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="w-full"
                disabled={busy}
                onClick={() => void run(() => confirmCreateWorktree("delete-and-create"))}
              >
                Delete and recreate branch
              </Button>
            </>
          ) : (
            <Button
              type="submit"
              variant="default"
              size="xs"
              className="w-full"
              disabled={!name.trim() || busy}
            >
              Create worktree
            </Button>
          )}
          <Button type="button" variant="outline" size="xs" className="w-full" onClick={cancel}>
            Cancel
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
