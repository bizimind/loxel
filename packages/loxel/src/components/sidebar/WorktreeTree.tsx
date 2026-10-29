/**
 * A project's worktrees in the sidebar, nested under their parents, for both sidebar states: the
 * collapsed rail and the expanded list render the same elements, so expanding the sidebar
 * animates between them (styles in `src/styles/worktree-tree.css`). A worktree with nested ones
 * is a group: a knob on the parent icon's bottom-left corner folds it, and a line runs down from
 * the knob, a faint bracket on the rail and a tree line when expanded. Archived worktrees live in
 * the project's Archive group at the bottom.
 */
import type { DragEndEvent, DragMoveEvent, DragStartEvent, Modifier } from "@dnd-kit/core";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { ArchiveIcon, ArchiveRestoreIcon, ChevronUpIcon, GitBranchPlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import type { WorktreeEntry } from "@/api/git-models";
import type { Project } from "@/api/project-model";
import { InlineRenameInput } from "@/components/tree";
import { NotificationDot } from "@/components/ui/notification-dot";
import { getTreeActionForEvent } from "@/hooks/useTreeKeyboardNav";
import { focusSidebarEntryForPath } from "@/lib/focus-navigation";
import { sidebarEntryProps } from "@/lib/focus-targets";
import { idToColor } from "@/lib/hash-color";
import { cn } from "@/lib/utils";
import {
  archivedSet,
  flattenTree,
  moveInOrder,
  resolveParents,
  resolveRowDrop,
  type RowDrop,
  type WorktreeNode,
  type WorktreeRow,
} from "@/lib/worktree-hierarchy";
import { hasWorktreeNotification, usePanelNotificationStore } from "@/store/panel-notifications";
import { deriveProject, useProjectStore } from "@/store/projects";
import {
  getOrderedWorktrees,
  getWorktreeTrees,
  useWorktreeStore,
  type ProjectState,
} from "@/store/worktrees";

import { WorktreeIcon } from "../worktrees/WorktreeIcon";
import { NewWorktreeDialog } from "./NewWorktreeDialog";
import {
  ICON_PX,
  KNOB_INSET,
  iconLeft,
  iconLeftExpanded,
  railShowsBelow,
} from "./worktree-geometry";
import { worktreeLabel, worktreeName, worktreeSubtitle } from "./worktree-labels";
import { WorktreeContextMenu, useWorktreeContextMenu } from "./WorktreeMenu";

/** The Archive group's drop target and sidebar entry. */
function archiveId(projectPath: string): string {
  return `archive:${projectPath}`;
}

/** The drop target after the last top-level worktree (the "Add worktree" row). */
function endId(projectPath: string): string {
  return `end:${projectPath}`;
}

const EMPTY_PROJECT_STATE: ProjectState = { worktrees: [] };

/**
 * Moves the drag overlay right of the pointer: centered on it, the overlay would cover the row it
 * is over and with it the drop line at that row's edge.
 */
const shiftOverlayRight: Modifier = ({ transform }) => ({ ...transform, x: transform.x + 28 });

// ── Tree ────────────────────────────────────────────────────────────────

/**
 * Where a dragged worktree lands: into the Archive group, or placed by the row drop rules among
 * the listed worktrees, among the archived ones, or from the Archive back into the list.
 */
type TreeDrop =
  | { kind: "archive" }
  | { kind: "place"; drop: RowDrop; from: "listed" | "archived" | "archive-out" };

export function WorktreeTree({ project, expanded }: { project: Project; expanded: boolean }) {
  const ps = useWorktreeStore((s) => s.byProject[project.path]) ?? EMPTY_PROJECT_STATE;
  const nesting = ps.worktreeMetadata ?? false;
  const activeWorktreePath = useWorktreeStore((s) => s.activeWorktreePath);
  const switchWorktree = useWorktreeStore((s) => s.switchWorktree);
  const renameWorktree = useWorktreeStore((s) => s.renameWorktree);
  const setCustomOrder = useWorktreeStore((s) => s.setCustomOrder);
  const toggleArchived = useWorktreeStore((s) => s.toggleArchived);
  const markArchived = useWorktreeStore((s) => s.markArchived);
  const toggleCollapsed = useWorktreeStore((s) => s.toggleCollapsed);
  const archiveOpen = useWorktreeStore((s) => s.openArchives.includes(project.path));
  const toggleArchiveOpen = useWorktreeStore((s) => s.toggleArchiveOpen);
  const createWorktreeRequested = useWorktreeStore((s) => s.createWorktreeRequested);
  const clearCreateWorktreeRequest = useWorktreeStore((s) => s.clearCreateWorktreeRequest);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);
  const homeDir = useProjectStore((s) => s.homeDir);

  const menu = useWorktreeContextMenu(project.path);
  const { handleSetParent, setError: setMenuError } = menu;

  const trees = useMemo(() => getWorktreeTrees(ps), [ps]);
  const collapsedSet = useMemo(() => new Set(ps.collapsedPaths), [ps.collapsedPaths]);
  const archived = useMemo(
    () => archivedSet(ps.worktrees, ps.archivedPaths ?? []),
    [ps.worktrees, ps.archivedPaths],
  );
  const parents = useMemo(() => resolveParents(ps.worktrees), [ps.worktrees]);
  const archiveEntry = archiveId(project.path);
  const endEntry = endId(project.path);

  /** Whether `node`'s nested worktrees are shown at `level`. */
  const isOpen = useCallback(
    (node: WorktreeNode<WorktreeEntry>, level: number) =>
      node.children.length > 0 &&
      !collapsedSet.has(node.wt.path) &&
      (expanded || railShowsBelow(level)),
    [collapsedSet, expanded],
  );
  const listedRows = useMemo(
    () => flattenTree(trees.listed, (node) => isOpen(node, node.depth)),
    [trees.listed, isOpen],
  );
  // The Archive draws its worktrees one level in.
  const archivedRows = useMemo(
    () =>
      archiveOpen ? flattenTree(trees.archived, (node) => isOpen(node, node.depth + 1), 1) : [],
    [archiveOpen, trees.archived, isOpen],
  );

  /** The New worktree dialog, open with the worktree it nests the new one under, if any. */
  const [newWorktree, setNewWorktree] = useState<{ parent?: WorktreeEntry } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  // Respond to keybinding-triggered create request
  useEffect(() => {
    if (!createWorktreeRequested) return;
    const activeProject = deriveProject(activeWorktreePath, useProjectStore.getState().projects);
    if (activeProject?.path !== project.path) return;
    clearCreateWorktreeRequest();
    setNewWorktree({});
  }, [createWorktreeRequested, clearCreateWorktreeRequest, activeWorktreePath, project.path]);

  const expandGroup = useCallback(
    (path: string) => {
      if (collapsedSet.has(path)) toggleCollapsed(project.path, path);
    },
    [collapsedSet, toggleCollapsed, project.path],
  );

  /** Unfold a group the rail folds because of its depth: only the expanded sidebar has room. */
  const expandFromRail = useCallback(
    (path: string) => {
      expandGroup(path);
      toggleSidebar();
    },
    [expandGroup, toggleSidebar],
  );

  const handleNewChild = useCallback(
    (wt: WorktreeEntry) => {
      expandGroup(wt.path);
      setNewWorktree({ parent: wt });
    },
    [expandGroup],
  );

  const handleRenameStart = useCallback(
    (wt: WorktreeEntry) => {
      if (!expanded) toggleSidebar();
      setRenamingPath(wt.path);
    },
    [expanded, toggleSidebar],
  );

  const handleRenameFinish = useCallback(
    async (wt: WorktreeEntry, value: string) => {
      setRenamingPath(null);
      try {
        // Renaming back to the worktree's own name clears the title.
        await renameWorktree(project.path, wt.path, value === worktreeName(wt) ? "" : value);
      } catch (err) {
        setMenuError(err instanceof Error ? err.message : "Failed to rename worktree");
      }
    },
    [renameWorktree, project.path, setMenuError],
  );

  // --- @dnd-kit: drop onto a row to nest, between rows to place it there ---
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ path: string; zone: RowDrop["zone"] } | null>(
    null,
  );
  const draggedWt = activeDragId ? ps.worktrees.find((wt) => wt.path === activeDragId) : undefined;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  }, []);

  /** The drop the pointer is over, or null where dropping would do nothing. */
  const resolveDrop = useCallback(
    (event: DragMoveEvent): TreeDrop | null => {
      const { active, over, activatorEvent, delta } = event;
      if (!over || !(activatorEvent instanceof MouseEvent)) return null;
      const moved = String(active.id);
      const target = String(over.id);
      const movedArchived = archived.has(moved);
      const targetArchived = target === archiveEntry || archived.has(target);
      // Anything dropped onto the Archive group, or among its worktrees, is archived.
      if (targetArchived && !movedArchived) return { kind: "archive" };
      if (target === archiveEntry) return null;

      // Out of the Archive: placed among the listed worktrees as if it were the last one.
      const movedWt = ps.worktrees.find((wt) => wt.path === moved);
      if (!movedWt) return null;
      const outsider: WorktreeRow<WorktreeEntry> = {
        wt: movedWt,
        depth: 0,
        parent: null,
        descendantCount: 0,
        collapsed: false,
      };
      const from = movedArchived ? (targetArchived ? "archived" : "archive-out") : "listed";
      const rows =
        from === "archived"
          ? archivedRows
          : from === "archive-out"
            ? [...listedRows, outsider]
            : listedRows;

      if (target === endEntry) {
        // After the last top-level worktree, whatever is nested below it.
        const last = trees.listed.at(-1)?.wt.path;
        if (
          !last ||
          last === moved ||
          (!nesting && rows.find((r) => r.wt.path === moved)?.parent)
        ) {
          return null;
        }
        return { kind: "place", drop: { path: last, zone: "after", parent: null }, from };
      }

      const ratio = (activatorEvent.clientY + delta.y - over.rect.top) / over.rect.height;
      const drop = resolveRowDrop(rows, moved, target, ratio, nesting);
      return drop && { kind: "place", drop, from };
    },
    [
      archived,
      archiveEntry,
      endEntry,
      ps.worktrees,
      listedRows,
      archivedRows,
      trees.listed,
      nesting,
    ],
  );

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      const target = resolveDrop(event);
      const next =
        target === null
          ? null
          : target.kind === "archive"
            ? { path: archiveEntry, zone: "inside" as const }
            : target.drop.path === trees.listed.at(-1)?.wt.path &&
                target.drop.parent === null &&
                target.drop.zone === "after" &&
                (trees.listed.at(-1)?.children.length ?? 0) > 0
              ? // After a whole group: drawn on the row below it.
                { path: endEntry, zone: "before" as const }
              : { path: target.drop.path, zone: target.drop.zone };
      setDropTarget((current) =>
        current?.path === next?.path && current?.zone === next?.zone ? current : next,
      );
    },
    [resolveDrop, archiveEntry, endEntry, trees.listed],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const target = resolveDrop(event);
      setActiveDragId(null);
      setDropTarget(null);
      if (!target) return;
      const moved = String(event.active.id);
      if (target.kind === "archive") {
        toggleArchived(project.path, moved);
        return;
      }
      const { drop, from } = target;
      // Out of the Archive, only the dragged worktree leaves: when it was archived with an
      // ancestor, moving it out of that ancestor's subtree is what takes it out.
      if (from === "archive-out" && (ps.archivedPaths ?? []).includes(moved)) {
        toggleArchived(project.path, moved);
      }
      if (drop.zone !== "inside") {
        const orderedPaths = getOrderedWorktrees(ps.worktrees, ps.customOrder).map((wt) => wt.path);
        setCustomOrder(project.path, moveInOrder(orderedPaths, moved, drop.path, drop.zone));
      }
      // Within a section, compare with the parent it is shown under: an archived worktree
      // nested under a listed one is drawn at the Archive's top level and keeps its parent.
      const shownParent =
        from === "archive-out"
          ? (parents.get(moved) ?? null)
          : ((from === "archived" ? archivedRows : listedRows).find((row) => row.wt.path === moved)
              ?.parent ?? null);
      if (drop.parent === shownParent) return;
      // Leaving an archived parent for the Archive's top level must not take it out of the Archive.
      if (from === "archived" && drop.parent === null) markArchived(project.path, moved);
      void handleSetParent(moved, drop.parent);
    },
    [
      resolveDrop,
      toggleArchived,
      markArchived,
      project.path,
      ps.worktrees,
      ps.customOrder,
      ps.archivedPaths,
      setCustomOrder,
      parents,
      listedRows,
      archivedRows,
      handleSetParent,
    ],
  );

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
    setDropTarget(null);
  }, []);

  /**
   * The tree's expand and collapse actions (Right and Left by default), as in the project
   * explorer: fold or unfold a group, else step to its parent or first child.
   */
  const handleTreeKey = (
    e: React.KeyboardEvent,
    item: {
      open: boolean;
      expandable: boolean;
      expand: () => void;
      collapse: () => void;
      parentEntry: string;
      firstChildEntry?: string;
    },
  ) => {
    const action = getTreeActionForEvent(e);
    if (action === "tree.expandOrFocusChild") {
      if (!item.expandable) return;
      e.preventDefault();
      e.stopPropagation();
      if (!item.open) item.expand();
      else if (item.firstChildEntry) focusSidebarEntryForPath(item.firstChildEntry);
    } else if (action === "tree.collapseOrFocusParent") {
      e.preventDefault();
      e.stopPropagation();
      if (item.expandable && item.open) item.collapse();
      else focusSidebarEntryForPath(item.parentEntry);
    }
  };

  const renderNodes = (
    nodes: readonly WorktreeNode<WorktreeEntry>[],
    level: number,
    parentEntry: string,
  ) => nodes.map((node) => renderNode(node, level, parentEntry));

  const renderNode = (node: WorktreeNode<WorktreeEntry>, level: number, parentEntry: string) => {
    const { wt } = node;
    const hasChildren = node.children.length > 0;
    const open = isOpen(node, level);
    // The rail folds groups below its last level; only the expanded sidebar can unfold them.
    const railFolded = hasChildren && !expanded && !railShowsBelow(level);
    const toggleOpen = () =>
      railFolded ? expandFromRail(wt.path) : toggleCollapsed(project.path, wt.path);

    const row = (
      <TreeRow
        key={hasChildren ? undefined : wt.path}
        wt={wt}
        pad={iconLeft(level)}
        padExpanded={iconLeftExpanded(level)}
        expanded={expanded}
        isActive={wt.path === activeWorktreePath}
        foldedPaths={open ? [] : descendantPaths(node)}
        activeWorktreePath={activeWorktreePath}
        archived={archived.has(wt.path)}
        isDragging={wt.path === activeDragId}
        dropZone={dropTarget?.path === wt.path ? dropTarget.zone : null}
        isRenaming={renamingPath === wt.path}
        homeDir={homeDir}
        knob={
          hasChildren
            ? {
                open,
                count: node.descendantCount,
                title: open ? "Collapse nested worktrees" : "Expand nested worktrees",
                onToggle: toggleOpen,
              }
            : undefined
        }
        onRenameFinish={(value) => handleRenameFinish(wt, value)}
        onRenameCancel={() => setRenamingPath(null)}
        onSelect={() => !wt.pending && switchWorktree(wt.path)}
        onContextMenu={(e) => !wt.pending && menu.handleContextMenu(e, wt)}
        onToggleArchived={() => toggleArchived(project.path, wt.path)}
        onToggleOpen={hasChildren ? toggleOpen : undefined}
        onKeyDown={(e) =>
          handleTreeKey(e, {
            open,
            expandable: hasChildren,
            expand: () => (railFolded ? expandFromRail(wt.path) : expandGroup(wt.path)),
            collapse: () => toggleCollapsed(project.path, wt.path),
            parentEntry,
            firstChildEntry: node.children[0]?.wt.path,
          })
        }
      />
    );
    if (!hasChildren) return row;

    return (
      <div
        key={wt.path}
        className="wt-group"
        style={groupStyle(idToColor(worktreeName(wt)).bg, level)}
      >
        {row}
        {open && renderNodes(node.children, level + 1, wt.path)}
      </div>
    );
  };

  const archivedCount = trees.archived.reduce((sum, node) => sum + 1 + node.descendantCount, 0);

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        modifiers={[restrictToVerticalAxis]}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div
          className={cn("wt-tree pb-0.5", expanded && "wt-tree-expanded")}
          style={{ "--wt-knob-inset": `${KNOB_INSET}px` } as React.CSSProperties}
        >
          {/* A bare repo's list is empty until its worktrees are fetched; a regular repo's
              main checkout is never listed, so for it an empty list is the normal state and
              the "Add worktree" row below is the affordance. */}
          {expanded && project.isBare && ps.worktrees.length === 0 && (
            <div
              className="text-muted-foreground cursor-pointer py-1.5 text-[11px] italic hover:underline"
              style={{ paddingLeft: `${iconLeftExpanded(0)}px` }}
              onClick={() => switchWorktree(project.path)}
            >
              Click to load worktrees
            </div>
          )}

          {renderNodes(trees.listed, 0, project.path)}

          {archivedCount > 0 && (
            <div className="wt-group" style={groupStyle("var(--muted-foreground)", 0, true)}>
              <ArchiveRow
                id={archiveEntry}
                count={archivedCount}
                open={archiveOpen}
                expanded={expanded}
                pad={iconLeft(0)}
                padExpanded={iconLeftExpanded(0)}
                foldedPaths={archiveOpen ? [] : [...archived]}
                activeInside={
                  !archiveOpen && activeWorktreePath !== null && archived.has(activeWorktreePath)
                }
                isDropTarget={dropTarget?.path === archiveEntry}
                onToggle={() => toggleArchiveOpen(project.path)}
                onKeyDown={(e) =>
                  handleTreeKey(e, {
                    open: archiveOpen,
                    expandable: true,
                    expand: () => toggleArchiveOpen(project.path),
                    collapse: () => toggleArchiveOpen(project.path),
                    parentEntry: project.path,
                    firstChildEntry: trees.archived[0]?.wt.path,
                  })
                }
              />
              {archiveOpen && renderNodes(trees.archived, 1, archiveEntry)}
            </div>
          )}

          <AddWorktreeRow
            id={endEntry}
            expanded={expanded}
            showDropLine={dropTarget?.path === endEntry}
            onClick={() => setNewWorktree({})}
          />
        </div>

        {/* Drag overlay */}
        <DragOverlay
          dropAnimation={{ duration: 200, easing: "ease" }}
          modifiers={[shiftOverlayRight]}
          className="pointer-events-none opacity-75"
        >
          {draggedWt ? (
            expanded ? (
              <div className="bg-card border-border flex items-center gap-2.5 rounded-md border px-2 py-1 shadow-lg">
                <WorktreeIcon name={worktreeName(draggedWt)} size="sm" />
                <span className="text-foreground truncate text-xs font-medium">
                  {worktreeLabel(draggedWt)}
                </span>
              </div>
            ) : (
              <WorktreeIcon name={worktreeName(draggedWt)} size="sm" />
            )
          ) : null}
        </DragOverlay>
      </DndContext>

      <WorktreeContextMenu menu={menu} onNewChild={handleNewChild} onRename={handleRenameStart} />

      {newWorktree && (
        <NewWorktreeDialog
          projectPath={project.path}
          parent={newWorktree.parent}
          titles={nesting}
          onClose={() => setNewWorktree(null)}
        />
      )}
    </>
  );
}

/**
 * A group's custom properties: its color, and where the line from its knob runs on the rail and
 * in the expanded list. The Archive's knob text uses the background, for contrast on gray.
 */
function groupStyle(color: string, level: number, archive = false): React.CSSProperties {
  return {
    "--wt-group-color": color,
    "--wt-line-x": `${iconLeft(level) + KNOB_INSET}px`,
    "--wt-line-x-expanded": `${iconLeftExpanded(level) + KNOB_INSET}px`,
    ...(archive ? { "--wt-knob-text": "var(--background)" } : {}),
  } as React.CSSProperties;
}

/** Every worktree below `node`. */
function descendantPaths(node: WorktreeNode<WorktreeEntry>): string[] {
  return node.children.flatMap((child) => [child.wt.path, ...descendantPaths(child)]);
}

// ── Rows ────────────────────────────────────────────────────────────────

/** The knob that folds a group, on its parent row's icon. */
interface KnobProps {
  open: boolean;
  /** Shown while folded: the worktrees it holds */
  count: number;
  title: string;
  onToggle: () => void;
}

/** A group's knob: the folded count, or a chevron that folds it while open. */
function Knob({ open, count, title, onToggle }: KnobProps) {
  return (
    <button
      className="wt-knob"
      title={title}
      aria-expanded={open}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      // Keep the knob from selecting, dragging or double-click folding the row it sits on.
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {open ? <ChevronUpIcon className="size-3" strokeWidth={3} /> : count}
    </button>
  );
}

interface TreeRowProps {
  wt: WorktreeEntry;
  /** The icon's left edge on the rail and in the expanded list */
  pad: number;
  padExpanded: number;
  expanded: boolean;
  isActive: boolean;
  /** Worktrees folded away below this one, whose notifications and selection it shows */
  foldedPaths: readonly string[];
  activeWorktreePath: string | null;
  archived: boolean;
  isDragging: boolean;
  dropZone: RowDrop["zone"] | null;
  isRenaming: boolean;
  homeDir: string | null;
  onRenameFinish: (value: string) => void;
  onRenameCancel: () => void;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onToggleArchived: () => void;
  /** The knob of the group it heads; absent without nested worktrees */
  knob?: KnobProps;
  /** Fold or unfold its nested worktrees; absent without any */
  onToggleOpen?: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

/** A worktree row that can be dragged, and dropped onto or next to. */
function TreeRow({
  wt,
  pad,
  padExpanded,
  expanded,
  isActive,
  foldedPaths,
  activeWorktreePath,
  archived,
  isDragging,
  dropZone,
  isRenaming,
  homeDir,
  onRenameFinish,
  onRenameCancel,
  onSelect,
  onContextMenu,
  onToggleArchived,
  knob,
  onToggleOpen,
  onKeyDown,
}: TreeRowProps) {
  const pending = wt.pending !== undefined;
  const drag = useDraggable({ id: wt.path, disabled: pending || isRenaming });
  const drop = useDroppable({ id: wt.path, disabled: pending });
  const rootRef = useCallback(
    (node: HTMLElement | null) => {
      drag.setNodeRef(node);
      drop.setNodeRef(node);
    },
    [drag.setNodeRef, drop.setNodeRef],
  );
  // A folded worktree also shows its hidden nested worktrees' notifications.
  const hasNotification = usePanelNotificationStore((s) =>
    [wt.path, ...foldedPaths].some((path) => hasWorktreeNotification(s, path)),
  );
  const activeInside = activeWorktreePath !== null && foldedPaths.includes(activeWorktreePath);
  const label = worktreeLabel(wt);
  const nestedCount = foldedPaths.length;
  const tooltip = useRailTooltip(expanded);

  return (
    <>
      <div
        ref={rootRef}
        className={cn("wt-row group", pending && "opacity-50", isDragging && "opacity-30")}
        style={
          {
            "--wt-icon-size": `${ICON_PX}px`,
            "--wt-pad": `${pad}px`,
            "--wt-pad-expanded": `${padExpanded}px`,
          } as React.CSSProperties
        }
        data-active={isActive || undefined}
        data-drop-inside={dropZone === "inside" || undefined}
        title={expanded ? (wt.title ? `${worktreeName(wt)}\n${wt.path}` : wt.path) : undefined}
        onClick={isRenaming ? undefined : onSelect}
        onDoubleClick={onToggleOpen}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        onMouseEnter={tooltip.show}
        onMouseLeave={tooltip.hide}
        {...drag.attributes}
        {...drag.listeners}
        {...(pending ? undefined : sidebarEntryProps(wt.path))}
      >
        {(dropZone === "before" || dropZone === "after") && (
          <div className="wt-drop-line" data-zone={dropZone} />
        )}
        {knob && <Knob {...knob} />}
        <div className="wt-row-icon" data-active-inside={activeInside || undefined}>
          <WorktreeIcon name={worktreeName(wt)} size="sm" active={isActive && !expanded} />
          {hasNotification && !isActive && <NotificationDot />}
        </div>
        <div className="wt-row-label">
          {isRenaming ? (
            <div className="flex">
              <InlineRenameInput
                currentName={label}
                onFinish={onRenameFinish}
                onCancel={onRenameCancel}
                className="text-foreground py-0.5"
              />
            </div>
          ) : (
            <div className="text-foreground truncate text-xs leading-4 font-medium">{label}</div>
          )}
          <div className="text-muted-foreground truncate text-[10px] leading-3.5">
            {worktreeSubtitle(wt, homeDir)}
            {nestedCount > 0 && ` · ${nestedCount} nested`}
          </div>
        </div>
        {expanded && !pending && (
          <button
            className="text-muted-foreground hover:text-foreground relative shrink-0 cursor-pointer opacity-0 transition-opacity group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              onToggleArchived();
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            title={archived ? "Unarchive worktree" : "Archive worktree"}
          >
            {archived ? (
              <ArchiveRestoreIcon className="size-3.5" />
            ) : (
              <ArchiveIcon className="size-3.5" />
            )}
          </button>
        )}
      </div>
      {tooltip.render(
        <>
          {label}
          {nestedCount > 0 && (
            <span className="text-muted-foreground ml-1.5 font-normal">
              ({nestedCount === 1 ? "1 nested worktree" : `${nestedCount} nested worktrees`})
            </span>
          )}
        </>,
      )}
    </>
  );
}

interface ArchiveRowProps {
  id: string;
  count: number;
  open: boolean;
  expanded: boolean;
  pad: number;
  padExpanded: number;
  /** Archived worktrees whose notifications the row shows while the Archive is closed */
  foldedPaths: readonly string[];
  activeInside: boolean;
  isDropTarget: boolean;
  onToggle: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

/** The head of a project's Archive group: opens and closes it, and takes worktrees dropped on it. */
function ArchiveRow({
  id,
  count,
  open,
  expanded,
  pad,
  padExpanded,
  foldedPaths,
  activeInside,
  isDropTarget,
  onToggle,
  onKeyDown,
}: ArchiveRowProps) {
  const drop = useDroppable({ id });
  const hasNotification = usePanelNotificationStore((s) =>
    foldedPaths.some((path) => hasWorktreeNotification(s, path)),
  );
  const tooltip = useRailTooltip(expanded);
  const countLabel = count === 1 ? "1 archived worktree" : `${count} archived worktrees`;

  return (
    <>
      <div
        ref={drop.setNodeRef}
        role="button"
        tabIndex={-1}
        className="wt-row"
        style={
          {
            "--wt-icon-size": `${ICON_PX}px`,
            "--wt-pad": `${pad}px`,
            "--wt-pad-expanded": `${padExpanded}px`,
          } as React.CSSProperties
        }
        data-drop-inside={isDropTarget || undefined}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={onKeyDown}
        onMouseEnter={tooltip.show}
        onMouseLeave={tooltip.hide}
        {...sidebarEntryProps(id)}
      >
        <div
          className="wt-row-icon bg-muted-foreground/25 text-foreground corner-superellipse flex size-6 items-center justify-center rounded-2xl"
          data-active-inside={activeInside || undefined}
        >
          <ArchiveIcon className="size-3.5" />
          {hasNotification && <NotificationDot />}
        </div>
        <Knob
          open={open}
          count={count}
          title={open ? "Close the archive" : "Open the archive"}
          onToggle={onToggle}
        />
        <div className="wt-row-label">
          <div className="text-foreground truncate text-xs leading-4 font-medium">Archive</div>
          <div className="text-muted-foreground truncate text-[10px] leading-3.5">{countLabel}</div>
        </div>
      </div>
      {tooltip.render(
        <>
          Archive
          <span className="text-muted-foreground ml-1.5 font-normal">({countLabel})</span>
        </>,
      )}
    </>
  );
}

/** The "Add worktree" row; dropping a worktree on it puts it after the last top-level one. */
function AddWorktreeRow({
  id,
  expanded,
  showDropLine,
  onClick,
}: {
  id: string;
  expanded: boolean;
  showDropLine: boolean;
  onClick: () => void;
}) {
  const drop = useDroppable({ id });
  return (
    <button
      ref={drop.setNodeRef}
      className="wt-row text-muted-foreground hover:text-foreground w-full text-left"
      style={
        {
          "--wt-icon-size": `${ICON_PX}px`,
          "--wt-pad": `${iconLeft(0)}px`,
          "--wt-pad-expanded": `${iconLeftExpanded(0)}px`,
        } as React.CSSProperties
      }
      title={expanded ? undefined : "Add worktree"}
      onClick={onClick}
    >
      {showDropLine && <div className="wt-drop-line" data-zone="before" />}
      <span className="wt-row-icon flex size-6 items-center justify-center">
        <GitBranchPlusIcon className="size-4" />
      </span>
      <span className="wt-row-label text-[11px]">Add worktree</span>
    </button>
  );
}

/** The name tooltip of a rail row: shown beside it on hover, only while the sidebar is collapsed. */
function useRailTooltip(expanded: boolean) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const show = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (expanded) return;
      const icon = e.currentTarget.querySelector(".wt-row-icon") ?? e.currentTarget;
      const rect = icon.getBoundingClientRect();
      setPosition({ top: rect.top + rect.height / 2, left: rect.right + 8 });
    },
    [expanded],
  );
  const hide = useCallback(() => setPosition(null), []);
  const render = (content: React.ReactNode) =>
    position !== null &&
    !expanded &&
    createPortal(
      <div
        className="animate-in fade-in slide-in-from-left-1 pointer-events-none fixed z-[9999] -translate-y-1/2 duration-150"
        style={position}
      >
        <div className="bg-popover border-border text-foreground rounded-md border px-2.5 py-1 text-xs font-medium whitespace-nowrap shadow-lg">
          {content}
        </div>
      </div>,
      document.body,
    );
  return { show, hide, render };
}
