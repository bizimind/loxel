import { GitBranchIcon, PencilIcon, TrashIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import {
  useCheckoutMutation,
  useDeleteBranchMutation,
  useRenameBranchMutation,
} from "@/queries/use-git-mutations";

type PendingAction = { kind: "rename" } | { kind: "delete" } | { kind: "delete-force" };

interface BranchContextMenuProps {
  open: boolean;
  position: { x: number; y: number };
  branchName: string;
  isCurrentBranch: boolean;
  onClose: () => void;
}

export function BranchContextMenu({
  open,
  position,
  branchName,
  isCurrentBranch,
  onClose,
}: BranchContextMenuProps) {
  const checkoutMutation = useCheckoutMutation();
  const deleteBranchMutation = useDeleteBranchMutation();
  const renameBranchMutation = useRenameBranchMutation();

  const [pending, setPending] = useState<PendingAction | null>(null);

  const handleCheckout = useCallback(async () => {
    onClose();
    await checkoutMutation.mutateAsync(branchName);
  }, [checkoutMutation, branchName, onClose]);

  const handleRename = useCallback(() => {
    onClose();
    setPending({ kind: "rename" });
  }, [onClose]);

  const handleDelete = useCallback(() => {
    onClose();
    setPending({ kind: "delete" });
  }, [onClose]);

  const handleDeleteForce = useCallback(() => {
    onClose();
    setPending({ kind: "delete-force" });
  }, [onClose]);

  const handleConfirmRename = useCallback(
    async (newName: string) => {
      setPending(null);
      if (newName === branchName) return;
      await renameBranchMutation.mutateAsync({ oldName: branchName, newName });
    },
    [renameBranchMutation, branchName],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (pending?.kind !== "delete" && pending?.kind !== "delete-force") return;
    const force = pending.kind === "delete-force";
    setPending(null);
    await deleteBranchMutation.mutateAsync({ name: branchName, force });
  }, [pending, deleteBranchMutation, branchName]);

  const deleteIsOpen = pending?.kind === "delete" || pending?.kind === "delete-force";
  const deleteForce = pending?.kind === "delete-force";

  return (
    <>
      <ContextMenu open={open} onOpenChange={(open) => !open && onClose()} position={position}>
        <ContextMenuLabel>{branchName}</ContextMenuLabel>
        <ContextMenuSeparator />

        <ContextMenuItem onClick={handleCheckout} disabled={isCurrentBranch}>
          <GitBranchIcon />
          Checkout
        </ContextMenuItem>

        <ContextMenuItem onClick={handleRename}>
          <PencilIcon />
          Rename
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onClick={handleDelete} disabled={isCurrentBranch}>
          <TrashIcon />
          Delete
        </ContextMenuItem>

        <ContextMenuItem
          onClick={handleDeleteForce}
          variant="destructive"
          disabled={isCurrentBranch}
        >
          <TrashIcon />
          Force delete
        </ContextMenuItem>
      </ContextMenu>

      <PromptDialog
        open={pending?.kind === "rename"}
        title="Rename branch"
        description={
          <>
            Rename <code>{branchName}</code>
          </>
        }
        defaultValue={branchName}
        confirmLabel="Rename"
        onConfirm={handleConfirmRename}
        onCancel={() => setPending(null)}
      />

      <ConfirmDialog
        open={deleteIsOpen}
        title={deleteForce ? "Force delete branch" : "Delete branch"}
        description={
          deleteForce ? (
            <>
              Force delete <code>{branchName}</code>? This cannot be undone.
            </>
          ) : (
            <>
              Delete branch <code>{branchName}</code>?
            </>
          )
        }
        confirmLabel={deleteForce ? "Force delete" : "Delete"}
        destructive
        onConfirm={handleConfirmDelete}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
