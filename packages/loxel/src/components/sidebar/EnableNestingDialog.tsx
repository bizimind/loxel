import { useEffect, useState } from "react";

import type { WorktreeMetadataAction } from "@/api/client";
import * as api from "@/api/client";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { useWorktreeStore } from "@/store/worktrees";

/**
 * Explains what turning on worktree metadata changes in the repository (the `wt init` action's
 * commands and tradeoffs), and turns it on once the user confirms.
 */
export function EnableNestingDialog({
  projectPath,
  onClose,
}: {
  projectPath: string;
  onClose: () => void;
}) {
  const enableWorktreeMetadata = useWorktreeStore((s) => s.enableWorktreeMetadata);
  // undefined while loading; null when the repository needs no change
  const [action, setAction] = useState<WorktreeMetadataAction | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .planEnableWorktreeMetadata(projectPath)
      .then((plan) => !cancelled && setAction(plan.action))
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to inspect the repo");
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await enableWorktreeMetadata(projectPath);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to enable worktree nesting");
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogShell open onCancel={onClose} className="w-[26rem]">
      <div className="px-4 pt-4 pb-2">
        <h3 className="text-foreground text-sm font-medium">Enable worktree nesting</h3>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
          Nesting shows worktrees under the worktree they belong to, and lets you give a worktree a
          title. Loxel stores both in each worktree&rsquo;s own git config, which needs git&rsquo;s
          per-worktree config turned on for this repository.
        </p>

        {action && (
          <div className="mt-3 flex flex-col gap-2">
            <pre className="bg-muted text-foreground overflow-x-auto rounded-md p-2 text-[10px] leading-relaxed">
              {action.commands.join("\n")}
            </pre>
            {action.tradeoffs.length > 0 && (
              <ul className="text-muted-foreground list-disc pl-4 text-[11px] leading-relaxed">
                {action.tradeoffs.map((tradeoff) => (
                  <li key={tradeoff}>{tradeoff}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {action === null && (
          <p className="text-muted-foreground mt-3 text-[11px]">
            Per-worktree config is already on for this repository.
          </p>
        )}

        {error && <div className="text-destructive mt-2 text-[10px]">{error}</div>}
      </div>

      <div className="flex flex-col gap-1.5 px-4 py-3">
        <Button
          variant="default"
          size="xs"
          className="w-full"
          disabled={action === undefined || busy}
          onClick={handleConfirm}
        >
          Enable nesting
        </Button>
        <Button variant="outline" size="xs" className="w-full" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </DialogShell>
  );
}
