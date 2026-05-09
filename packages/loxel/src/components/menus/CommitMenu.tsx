import {
  CherryIcon,
  CopyIcon,
  GitBranchIcon,
  RotateCcwIcon,
  TrashIcon,
  UndoIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import {
  useCheckoutMutation,
  useCherryPickMutation,
  useCreateBranchMutation,
  useResetMutation,
  useRevertMutation,
} from "@/queries/use-git-mutations";
import { useCommitsQuery } from "@/queries/use-repo-queries";
import { useRepositoryStore } from "@/store/worktree-repository";
import { useWorktreeUI } from "@/store/worktree-ui";

type ResetMode = "soft" | "mixed" | "hard";

type PendingAction = { kind: "reset"; mode: ResetMode } | { kind: "create-branch" };

interface CommitContextMenuProps {
  open: boolean;
  position: { x: number; y: number };
  commitHash: string;
  onClose: () => void;
}

export function CommitContextMenu({ open, position, commitHash, onClose }: CommitContextMenuProps) {
  const branchFilterPreset = useWorktreeUI((s) => s.branchFilterPreset);
  const { data: commitsData } = useCommitsQuery(branchFilterPreset);
  const commits = commitsData?.commits ?? [];
  const selectedCommits = useRepositoryStore((s) => s.selectedCommits);

  const checkoutMutation = useCheckoutMutation();
  const resetMutation = useResetMutation();
  const cherryPickMutation = useCherryPickMutation();
  const revertMutation = useRevertMutation();
  const createBranchMutation = useCreateBranchMutation();

  const [pending, setPending] = useState<PendingAction | null>(null);

  const commit = useMemo(() => commits.find((c) => c.hash === commitHash), [commits, commitHash]);

  const isMultiSelect = selectedCommits.size > 1 && selectedCommits.has(commitHash);
  const selectedHashes = isMultiSelect ? Array.from(selectedCommits) : [commitHash];

  const shortHash = commitHash.slice(0, 7);

  const handleCheckout = useCallback(async () => {
    onClose();
    await checkoutMutation.mutateAsync(commitHash);
  }, [checkoutMutation, commitHash, onClose]);

  const handleResetSoft = useCallback(() => {
    onClose();
    setPending({ kind: "reset", mode: "soft" });
  }, [onClose]);

  const handleResetMixed = useCallback(() => {
    onClose();
    setPending({ kind: "reset", mode: "mixed" });
  }, [onClose]);

  const handleResetHard = useCallback(() => {
    onClose();
    setPending({ kind: "reset", mode: "hard" });
  }, [onClose]);

  const handleCherryPick = useCallback(async () => {
    onClose();
    await cherryPickMutation.mutateAsync(selectedHashes);
  }, [cherryPickMutation, selectedHashes, onClose]);

  const handleRevert = useCallback(async () => {
    onClose();
    await revertMutation.mutateAsync(selectedHashes);
  }, [revertMutation, selectedHashes, onClose]);

  const handleCopyHash = useCallback(() => {
    onClose();
    navigator.clipboard.writeText(commitHash);
  }, [commitHash, onClose]);

  const handleCreateBranch = useCallback(() => {
    onClose();
    setPending({ kind: "create-branch" });
  }, [onClose]);

  const handleConfirmReset = useCallback(async () => {
    if (pending?.kind !== "reset") return;
    const mode = pending.mode;
    setPending(null);
    await resetMutation.mutateAsync({ commit: commitHash, mode });
  }, [pending, resetMutation, commitHash]);

  const handleConfirmCreateBranch = useCallback(
    async (name: string) => {
      setPending(null);
      await createBranchMutation.mutateAsync({ name, startPoint: commitHash });
    },
    [createBranchMutation, commitHash],
  );

  const resetIsOpen = pending?.kind === "reset";
  const resetMode: ResetMode = resetIsOpen ? pending.mode : "soft";

  if (!commit) return null;

  return (
    <>
      <ContextMenu open={open} onOpenChange={(open) => !open && onClose()} position={position}>
        <ContextMenuLabel>
          {isMultiSelect ? `${selectedCommits.size} commits` : commit.shortHash}
        </ContextMenuLabel>
        <ContextMenuSeparator />

        <ContextMenuItem onClick={handleCheckout}>
          <GitBranchIcon />
          Checkout
        </ContextMenuItem>

        <ContextMenuItem onClick={handleCreateBranch}>
          <GitBranchIcon />
          Create branch here
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onClick={handleCherryPick}>
          <CherryIcon />
          Cherry-pick {isMultiSelect && `(${selectedCommits.size})`}
        </ContextMenuItem>

        <ContextMenuItem onClick={handleRevert}>
          <UndoIcon />
          Revert {isMultiSelect && `(${selectedCommits.size})`}
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onClick={handleResetSoft}>
          <RotateCcwIcon />
          Reset soft
          <ContextMenuShortcut>Keep staged</ContextMenuShortcut>
        </ContextMenuItem>

        <ContextMenuItem onClick={handleResetMixed}>
          <RotateCcwIcon />
          Reset mixed
          <ContextMenuShortcut>Unstage</ContextMenuShortcut>
        </ContextMenuItem>

        <ContextMenuItem onClick={handleResetHard} variant="destructive">
          <TrashIcon />
          Reset hard
          <ContextMenuShortcut>Discard all</ContextMenuShortcut>
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onClick={handleCopyHash}>
          <CopyIcon />
          Copy commit hash
        </ContextMenuItem>
      </ContextMenu>

      <ConfirmDialog
        open={resetIsOpen}
        title={`Reset (${resetMode})`}
        description={resetDescription(resetMode, shortHash)}
        confirmLabel="Reset"
        destructive={resetMode === "hard"}
        onConfirm={handleConfirmReset}
        onCancel={() => setPending(null)}
      />

      <PromptDialog
        open={pending?.kind === "create-branch"}
        title="Create branch"
        description={
          <>
            Branch from <code>{shortHash}</code>
          </>
        }
        placeholder="branch-name"
        confirmLabel="Create"
        onConfirm={handleConfirmCreateBranch}
        onCancel={() => setPending(null)}
      />
    </>
  );
}

function resetDescription(mode: ResetMode, shortHash: string): ReactNode {
  const detail =
    mode === "soft"
      ? "Staged changes will be preserved."
      : mode === "mixed"
        ? "Changes will be unstaged."
        : "All changes will be lost.";
  return (
    <>
      Reset to <code>{shortHash}</code>? {detail}
    </>
  );
}
