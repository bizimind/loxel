import {
  ClipboardPasteIcon,
  CopyIcon,
  FilePlusIcon,
  FolderMinusIcon,
  FolderPlusIcon,
  FolderRootIcon,
  FolderTreeIcon,
  PencilIcon,
  ScissorsIcon,
  TrashIcon,
  TypeIcon,
  Undo2Icon,
} from "lucide-react";

import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu";
import { copyToClipboard } from "@/lib/clipboard";
import { FileTypeIcon } from "@/lib/file-icons";
import { pathName } from "@/lib/project-file-helpers";

import { OpenInMenuItems, isOpenInSupported } from "./OpenInMenuItems";

interface ProjectFileMenuProps {
  open: boolean;
  position: { x: number; y: number };
  /** Absolute path of the file or folder. */
  filePath: string;
  /** Path relative to its tree root; "Copy Relative Path" is shown only when set. */
  relativePath?: string;
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
  /** Close a folder in the Others section (the folder stays on disk). */
  onRemoveFromOthers?: () => void;
}

export function ProjectFileMenu({
  open,
  position,
  filePath,
  relativePath,
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
  onRemoveFromOthers,
}: ProjectFileMenuProps) {
  const fileName = pathName(filePath);

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

      {(hasNewSection || hasRename || hasClipboard) && <ContextMenuSeparator />}

      <ContextMenuItem
        onClick={() => {
          onClose();
          copyToClipboard(fileName, "name");
        }}
      >
        <TypeIcon />
        Copy Name
      </ContextMenuItem>

      {relativePath && (
        <ContextMenuItem
          onClick={() => {
            onClose();
            copyToClipboard(relativePath, "relative path");
          }}
        >
          <FolderTreeIcon />
          Copy Relative Path
        </ContextMenuItem>
      )}

      <ContextMenuItem
        onClick={() => {
          onClose();
          copyToClipboard(filePath, "absolute path");
        }}
      >
        <FolderRootIcon />
        Copy Absolute Path
      </ContextMenuItem>

      {isOpenInSupported && <ContextMenuSeparator />}

      <OpenInMenuItems path={filePath} />

      {onRemoveFromOthers && <ContextMenuSeparator />}

      {onRemoveFromOthers && (
        <ContextMenuItem
          onClick={() => {
            onClose();
            onRemoveFromOthers();
          }}
        >
          <FolderMinusIcon />
          Remove from Others
        </ContextMenuItem>
      )}

      {hasDestructive && <ContextMenuSeparator />}

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
