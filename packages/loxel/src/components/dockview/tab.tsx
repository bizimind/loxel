import type { DockviewPanelApi } from "dockview-react";

import { useCallback, useState } from "react";

import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";

import { TabCloseButton } from "./tab-close-button";

/** Context menu items for file-backed tabs (editor, media). */
export function FileContextMenuItems({
  filename,
  filePath,
  worktreePath,
}: {
  filename: string;
  filePath: string;
  /** When set and filePath is inside the worktree, a "Copy Relative Path" item is shown. */
  worktreePath?: string;
}) {
  const relativePath =
    worktreePath && filePath.startsWith(worktreePath + "/")
      ? filePath.slice(worktreePath.length + 1)
      : undefined;

  return (
    <>
      <ContextMenuItem onClick={() => navigator.clipboard.writeText(filename)}>
        Copy File Name
      </ContextMenuItem>
      {relativePath && (
        <ContextMenuItem onClick={() => navigator.clipboard.writeText(relativePath)}>
          Copy Relative Path
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => navigator.clipboard.writeText(filePath)}>
        Copy File Path
      </ContextMenuItem>
    </>
  );
}

interface TabProps {
  api: DockviewPanelApi;
  icon: React.ReactNode;
  title: string;
  /** Optional leading content rendered before the icon (e.g. status dots). */
  leading?: React.ReactNode;
  /** Optional trailing content rendered after the title (e.g. action buttons). */
  trailing?: React.ReactNode;
  /** Optional extra context menu items rendered above the standard close actions. */
  contextMenuItems?: React.ReactNode;
}

/** Shared dockview tab layout: optional leading content, icon, truncated title, and close button. */
export function Tab({ api, icon, title, leading, trailing, contextMenuItems }: TabProps) {
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctxPosition, setCtxPosition] = useState({ x: 0, y: 0 });

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxPosition({ x: e.clientX, y: e.clientY });
    setCtxOpen(true);
  }, []);

  const handleClose = useCallback(() => api.close(), [api]);

  const handleCloseOthers = useCallback(() => {
    for (const panel of Array.from(api.group.panels)) {
      if (panel.id !== api.id) panel.api.close();
    }
  }, [api]);

  const handleCloseAll = useCallback(() => {
    for (const panel of Array.from(api.group.panels)) {
      panel.api.close();
    }
  }, [api]);

  return (
    <>
      <div className="dv-default-tab" onContextMenu={handleContextMenu}>
        <div className="dv-default-tab-content flex items-center gap-1.5">
          {leading}
          {icon}
          <span className="truncate">{title}</span>
          {trailing}
        </div>
        <TabCloseButton api={api} />
      </div>
      <ContextMenu open={ctxOpen} onOpenChange={setCtxOpen} position={ctxPosition}>
        {contextMenuItems}
        {contextMenuItems && <ContextMenuSeparator />}
        <ContextMenuItem onClick={handleClose}>Close</ContextMenuItem>
        <ContextMenuItem disabled={api.group.panels.length <= 1} onClick={handleCloseOthers}>
          Close Others
        </ContextMenuItem>
        <ContextMenuItem onClick={handleCloseAll}>Close All</ContextMenuItem>
      </ContextMenu>
    </>
  );
}
