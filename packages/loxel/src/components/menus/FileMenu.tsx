import { MinusIcon, PlusIcon, TrashIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { FileTypeIcon } from "@/lib/file-icons";
import {
  useDiscardChangesMutation,
  useStageFilesMutation,
  useUnstageFilesMutation,
} from "@/queries/use-git-mutations";

interface FileContextMenuProps {
  open: boolean;
  position: { x: number; y: number };
  filePath: string;
  isStaged: boolean;
  onClose: () => void;
}

export function FileContextMenu({
  open,
  position,
  filePath,
  isStaged,
  onClose,
}: FileContextMenuProps) {
  const stageFilesMutation = useStageFilesMutation();
  const unstageFilesMutation = useUnstageFilesMutation();
  const discardChangesMutation = useDiscardChangesMutation();

  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const handleStage = useCallback(async () => {
    onClose();
    await stageFilesMutation.mutateAsync([filePath]);
  }, [stageFilesMutation, filePath, onClose]);

  const handleUnstage = useCallback(async () => {
    onClose();
    await unstageFilesMutation.mutateAsync([filePath]);
  }, [unstageFilesMutation, filePath, onClose]);

  const handleDiscard = useCallback(() => {
    onClose();
    setConfirmDiscard(true);
  }, [onClose]);

  const handleConfirmDiscard = useCallback(async () => {
    setConfirmDiscard(false);
    await discardChangesMutation.mutateAsync([filePath]);
  }, [discardChangesMutation, filePath]);

  const fileName = filePath.split("/").pop() ?? filePath;

  return (
    <>
      <ContextMenu open={open} onOpenChange={(open) => !open && onClose()} position={position}>
        <ContextMenuLabel className="flex items-center gap-2">
          <FileTypeIcon filename={fileName} className="size-3.5" />
          {fileName}
        </ContextMenuLabel>
        <ContextMenuSeparator />

        {isStaged ? (
          <ContextMenuItem onClick={handleUnstage}>
            <MinusIcon />
            Unstage
          </ContextMenuItem>
        ) : (
          <>
            <ContextMenuItem onClick={handleStage}>
              <PlusIcon />
              Stage
            </ContextMenuItem>

            <ContextMenuSeparator />

            <ContextMenuItem onClick={handleDiscard} variant="destructive">
              <TrashIcon />
              Discard changes
            </ContextMenuItem>
          </>
        )}
      </ContextMenu>

      <ConfirmDialog
        open={confirmDiscard}
        title="Discard changes"
        description={
          <>
            Discard changes to <code>{filePath}</code>? This cannot be undone.
          </>
        }
        confirmLabel="Discard"
        destructive
        onConfirm={handleConfirmDiscard}
        onCancel={() => setConfirmDiscard(false)}
      />
    </>
  );
}
