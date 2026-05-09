import {
  ClipboardPasteIcon,
  CopyIcon,
  FilePlusIcon,
  FolderPlusIcon,
  PencilIcon,
  ScissorsIcon,
  TrashIcon,
  Undo2Icon,
} from "lucide-react";

import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu";
import { FileTypeIcon } from "@/lib/file-icons";

interface ProjectFileMenuProps {
  open: boolean;
  position: { x: number; y: number };
  filePath: string;
  isDir: boolean;
  canPaste?: boolean;
  onClose: () => void;
  onNewFile?: () => void;
  onNewDir?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onCut?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  onGitRestore?: () => void;
}

export function ProjectFileMenu({
  open,
  position,
  filePath,
  isDir,
  canPaste,
  onClose,
  onNewFile,
  onNewDir,
  onRename,
  onDelete,
  onCut,
  onCopy,
  onPaste,
  onGitRestore,
}: ProjectFileMenuProps) {
  const fileName = filePath.split("/").pop() ?? filePath;

  const hasNewSection = onNewFile || onNewDir;
  const hasRename = !!onRename;
  const hasClipboard = onCut || onCopy || onPaste;
  const hasDestructive = onDelete || onGitRestore;

  return (
    <ContextMenu open={open} onOpenChange={(o) => !o && onClose()} position={position}>
      <ContextMenuLabel className="flex items-center gap-2">
        <FileTypeIcon filename={fileName} isFolder={isDir} className="size-3.5" />
        {fileName}
      </ContextMenuLabel>
      <ContextMenuSeparator />

      {onNewFile && (
        <ContextMenuItem
          onClick={() => {
            onClose();
            onNewFile();
          }}
        >
          <FilePlusIcon />
          New File
        </ContextMenuItem>
      )}

      {onNewDir && (
        <ContextMenuItem
          onClick={() => {
            onClose();
            onNewDir();
          }}
        >
          <FolderPlusIcon />
          New Directory
        </ContextMenuItem>
      )}

      {hasNewSection && hasRename && <ContextMenuSeparator />}

      {onRename && (
        <ContextMenuItem
          onClick={() => {
            onClose();
            onRename();
          }}
        >
          <PencilIcon />
          Rename
          <ContextMenuShortcut>&#x21E7;F6</ContextMenuShortcut>
        </ContextMenuItem>
      )}

      {(hasRename || hasNewSection) && hasClipboard && <ContextMenuSeparator />}

      {onCut && (
        <ContextMenuItem
          onClick={() => {
            onClose();
            onCut();
          }}
        >
          <ScissorsIcon />
          Cut
          <ContextMenuShortcut>&#x2318;X</ContextMenuShortcut>
        </ContextMenuItem>
      )}

      {onCopy && (
        <ContextMenuItem
          onClick={() => {
            onClose();
            onCopy();
          }}
        >
          <CopyIcon />
          Copy
          <ContextMenuShortcut>&#x2318;C</ContextMenuShortcut>
        </ContextMenuItem>
      )}

      {onPaste && (
        <ContextMenuItem
          disabled={!canPaste}
          onClick={() => {
            onClose();
            onPaste();
          }}
        >
          <ClipboardPasteIcon />
          Paste
          <ContextMenuShortcut>&#x2318;V</ContextMenuShortcut>
        </ContextMenuItem>
      )}

      {hasClipboard && hasDestructive && <ContextMenuSeparator />}

      {onGitRestore && (
        <ContextMenuItem
          variant="destructive"
          onClick={() => {
            onClose();
            onGitRestore();
          }}
        >
          <Undo2Icon />
          Git Restore
        </ContextMenuItem>
      )}

      {onDelete && (
        <ContextMenuItem
          variant="destructive"
          onClick={() => {
            onClose();
            onDelete();
          }}
        >
          <TrashIcon />
          Delete
          <ContextMenuShortcut>&#x232B;</ContextMenuShortcut>
        </ContextMenuItem>
      )}
    </ContextMenu>
  );
}
