import { useQuery } from "@tanstack/react-query";
import { CopyIcon, CrosshairIcon, FileDiffIcon, FileIcon, Undo2Icon } from "lucide-react";

import { getPathInfo } from "@/api/client";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { FileTypeIcon } from "@/lib/file-icons";
import { pathName } from "@/lib/project-file-helpers";
import { queryKeys } from "@/queries/query-keys";

import { OpenInMenuItems, isOpenInSupported } from "./OpenInMenuItems";

interface ChangesFileMenuProps {
  position: { x: number; y: number };
  /** The entry's path relative to the repository root, as the diff lists it. */
  path: string;
  /** Where the entry is (or would be) on disk. */
  absolutePath: string;
  isDir: boolean;
  onClose: () => void;
  onOpenDiff?: () => void;
  onOpenFile?: () => void;
  onRevealInExplorer?: () => void;
  /** Only offered while the panel shows a worktree's local changes. */
  onDiscard?: () => void;
}

/**
 * Context menu for a changes panel entry. A diff can list paths that are no longer on disk (a
 * deleted file, or a file of a past commit that was since removed), so the items that act on the
 * file on disk are disabled until it is known to exist.
 */
export function ChangesFileMenu({
  position,
  path,
  absolutePath,
  isDir,
  onClose,
  onOpenDiff,
  onOpenFile,
  onRevealInExplorer,
  onDiscard,
}: ChangesFileMenuProps) {
  // Checked afresh each time the menu opens: discards and agents add and remove files.
  const { data: onDisk = false } = useQuery({
    queryKey: queryKeys.pathExists(absolutePath),
    queryFn: () =>
      getPathInfo(absolutePath).then(
        () => true,
        () => false,
      ),
    staleTime: 0,
    gcTime: 0,
  });

  const name = pathName(path);
  const hasOpenSection = onOpenDiff || onOpenFile || onRevealInExplorer;

  const run = (action: () => void) => () => {
    onClose();
    action();
  };

  return (
    <ContextMenu open onOpenChange={(open) => !open && onClose()} position={position}>
      <ContextMenuLabel className="flex items-center gap-2">
        <FileTypeIcon filename={name} isFolder={isDir} className="size-3.5" />
        {name}
      </ContextMenuLabel>
      <ContextMenuSeparator />

      {onOpenDiff && (
        <ContextMenuItem onClick={run(onOpenDiff)}>
          <FileDiffIcon />
          Open Diff
        </ContextMenuItem>
      )}

      {onOpenFile && (
        <ContextMenuItem disabled={!onDisk} onClick={run(onOpenFile)}>
          <FileIcon />
          Open File
        </ContextMenuItem>
      )}

      {onRevealInExplorer && (
        <ContextMenuItem disabled={!onDisk} onClick={run(onRevealInExplorer)}>
          <CrosshairIcon />
          Reveal in Project Explorer
        </ContextMenuItem>
      )}

      {hasOpenSection && <ContextMenuSeparator />}

      <ContextMenuItem onClick={run(() => navigator.clipboard.writeText(path))}>
        <CopyIcon />
        Copy Relative Path
      </ContextMenuItem>
      <ContextMenuItem onClick={run(() => navigator.clipboard.writeText(absolutePath))}>
        <CopyIcon />
        Copy Path
      </ContextMenuItem>

      {isOpenInSupported && <ContextMenuSeparator />}

      <OpenInMenuItems path={absolutePath} disabled={!onDisk} />

      {onDiscard && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={run(onDiscard)}>
            <Undo2Icon />
            Discard Changes
          </ContextMenuItem>
        </>
      )}
    </ContextMenu>
  );
}
