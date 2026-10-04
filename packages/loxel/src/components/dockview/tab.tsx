import type { DockviewPanelApi } from "dockview-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { OpenInMenuItems, isOpenInSupported } from "@/components/menus/OpenInMenuItems";
import { InlineRenameInput } from "@/components/tree";
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
      {isOpenInSupported && <ContextMenuSeparator />}
      <OpenInMenuItems path={filePath} />
    </>
  );
}

/** The panel's title, re-rendering when it changes (`api.setTitle`). */
export function usePanelTitle(api: DockviewPanelApi): string | undefined {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const disposable = api.onDidTitleChange(onChange);
      return () => disposable.dispose();
    },
    [api],
  );
  return useSyncExternalStore(subscribe, () => api.title);
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
  /**
   * Makes the tab renameable: a "Rename" context menu item and double-clicking the title edit
   * the title inline, and this is called with the new, changed, non-empty name.
   */
  onRename?: (newName: string) => void;
  /** When renaming, initially select only the part before the extension (file names). */
  selectBaseName?: boolean;
}

/**
 * Shared dockview tab layout: optional leading content, icon, truncated title (or an inline
 * rename input), and close button.
 */
export function Tab({
  api,
  icon,
  title,
  leading,
  trailing,
  contextMenuItems,
  onRename,
  selectBaseName,
}: TabProps) {
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctxPosition, setCtxPosition] = useState({ x: 0, y: 0 });
  const [isRenaming, setIsRenaming] = useState(false);
  const tabRef = useRef<HTMLDivElement>(null);

  // While renaming, keep pointer interaction inside the input. Dockview makes the whole tab
  // draggable, which turns a drag in the input into a tab drag instead of a text selection, and
  // its native pointerdown/click listeners on the tab activate the panel and group (moving focus
  // out of the input, which commits the rename) or float the tab on shift+pointerdown. Those
  // listeners run before React's, so stop the events natively at the input.
  useEffect(() => {
    if (!isRenaming) return;
    const tabElement = tabRef.current?.closest<HTMLElement>(".dv-tab");
    const input = tabRef.current?.querySelector("input");
    const stopPropagation = (e: Event) => e.stopPropagation();
    input?.addEventListener("pointerdown", stopPropagation);
    input?.addEventListener("click", stopPropagation);
    const suspendDrag = tabElement?.getAttribute("draggable") === "true";
    if (suspendDrag) tabElement?.setAttribute("draggable", "false");
    return () => {
      input?.removeEventListener("pointerdown", stopPropagation);
      input?.removeEventListener("click", stopPropagation);
      // Dockview may have reset it meanwhile (its drag-and-drop options changed).
      if (suspendDrag && tabElement?.getAttribute("draggable") === "false") {
        tabElement.setAttribute("draggable", "true");
      }
    };
  }, [isRenaming]);

  const handleFinishRename = useCallback(
    (newName: string) => {
      setIsRenaming(false);
      onRename?.(newName);
    },
    [onRename],
  );

  const handleCancelRename = useCallback(() => setIsRenaming(false), []);

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
      <div ref={tabRef} className="dv-default-tab" onContextMenu={handleContextMenu}>
        <div className="dv-default-tab-content flex items-center gap-1.5">
          {leading}
          {icon}
          {isRenaming ? (
            <InlineRenameInput
              currentName={title}
              selectBaseName={selectBaseName}
              className="field-sizing-content max-w-64 min-w-16 flex-none"
              onFinish={handleFinishRename}
              onCancel={handleCancelRename}
            />
          ) : (
            <span
              className="truncate"
              onDoubleClick={onRename ? () => setIsRenaming(true) : undefined}
            >
              {title}
            </span>
          )}
          {trailing}
        </div>
        <TabCloseButton api={api} />
      </div>
      <ContextMenu open={ctxOpen} onOpenChange={setCtxOpen} position={ctxPosition}>
        {onRename && (
          <>
            <ContextMenuItem onClick={() => setIsRenaming(true)}>Rename</ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
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
