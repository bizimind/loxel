import type {
  ColumnOrderState,
  ColumnSizingState,
  Header,
  VisibilityState,
} from "@tanstack/react-table";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { PencilLineIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CommitInfo } from "@/api/git-models";
import { isUncommittedHash } from "@/api/git-models";
import { useCommitsWithUncommitted } from "@/hooks/useCommitsWithUncommitted";
import { cn } from "@/lib/utils";
import { useCommitsQuery } from "@/queries/use-repo-queries";
import { useRepositoryStore } from "@/store/worktree-repository";
import { getCurrentWorktreeUI, useWorktreeUI } from "@/store/worktree-ui";

import { CommitContextMenu } from "../menus/CommitMenu";
import { BranchLine } from "./BranchLine";
import { CommitNode } from "./CommitNode";
import { REF_LABELS_WIDTH } from "./constants";
import type { LayoutNode } from "./layout";
import { calculateLayout } from "./layout";

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffWeeks < 4) return `${diffWeeks}w ago`;
  if (diffMonths < 12) return `${diffMonths}mo ago`;
  return date.toLocaleDateString();
}

const columnHelper = createColumnHelper<LayoutNode>();

function buildColumns(graphWidth: number) {
  return [
    columnHelper.display({
      id: "graph",
      size: graphWidth + REF_LABELS_WIDTH,
      minSize: 60,
      enableResizing: true,
      enableHiding: false,
    }),
    columnHelper.accessor((row) => row.commit.shortHash, {
      id: "hash",
      size: 70,
      minSize: 50,
      enableResizing: true,
      enableHiding: true,
    }),
    columnHelper.accessor((row) => row.commit.message, {
      id: "subject",
      enableResizing: false,
      enableHiding: false,
    }),
    columnHelper.accessor((row) => row.commit.author, {
      id: "author",
      size: 100,
      minSize: 60,
      enableResizing: true,
      enableHiding: true,
    }),
    columnHelper.accessor((row) => row.commit.authorDate, {
      id: "date",
      size: 70,
      minSize: 65,
      enableResizing: true,
      enableHiding: true,
      cell: (info) => formatRelativeTime(info.getValue()),
    }),
  ];
}

/**
 * Creates an inverted resize handler for left-edge handles.
 * TanStack's built-in handler assumes right-edge (drag right = wider).
 * For columns after the flex subject column, the boundary is on the left,
 * so drag right = narrower (inverted delta).
 */
function createInvertedResizeHandler(
  table: ReturnType<typeof useReactTable<LayoutNode>>,
  header: Header<LayoutNode, unknown>,
) {
  return (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = "touches" in e ? e.touches[0]!.clientX : e.clientX;
    const startWidth = header.getSize();
    const minSize = header.column.columnDef.minSize ?? 30;

    const handleMove = (moveEvent: MouseEvent | TouchEvent) => {
      const currentX = "touches" in moveEvent ? moveEvent.touches[0]!.clientX : moveEvent.clientX;
      const delta = startX - currentX;
      const newWidth = Math.max(minSize, startWidth + delta);
      table.setColumnSizing((prev) => ({ ...prev, [header.id]: newWidth }));
    };

    const handleUp = () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      document.removeEventListener("touchmove", handleMove);
      document.removeEventListener("touchend", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    document.addEventListener("touchmove", handleMove);
    document.addEventListener("touchend", handleUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
}

/**
 * Determines resize handle placement for a column.
 * Columns before/at the flex "subject" get a right-edge handle (standard direction).
 * Columns after subject get a left-edge handle (inverted direction).
 */
function getResizeSides(
  headers: Header<LayoutNode, unknown>[],
  header: Header<LayoutNode, unknown>,
): { left: boolean; right: boolean } {
  const subjectIndex = headers.findIndex((h) => h.id === "subject");
  const headerIndex = headers.indexOf(header);
  if (subjectIndex === -1 || headerIndex <= subjectIndex) {
    return { left: false, right: true };
  }
  return { left: true, right: false };
}

// Full-height resize handles overlaying the entire content area
function ColumnResizeOverlay({ table }: { table: ReturnType<typeof useReactTable<LayoutNode>> }) {
  const headers = table.getHeaderGroups()[0]!.headers;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex">
      {headers.map((header) => {
        const isSubject = header.id === "subject";
        const sides = header.column.getCanResize() ? getResizeSides(headers, header) : null;

        return (
          <div
            key={header.id}
            style={isSubject ? undefined : { width: header.getSize() }}
            className={isSubject ? "min-w-0 flex-1" : "relative shrink-0"}
          >
            {sides?.right && (
              <div
                className="hover:bg-primary/30 pointer-events-auto absolute top-0 -right-px h-full w-0.5 cursor-col-resize"
                onMouseDown={header.getResizeHandler()}
                onTouchStart={header.getResizeHandler()}
              />
            )}
            {sides?.left && (
              <div
                className="hover:bg-primary/30 pointer-events-auto absolute top-0 -left-px h-full w-0.5 cursor-col-resize"
                onMouseDown={createInvertedResizeHandler(table, header)}
                onTouchStart={createInvertedResizeHandler(table, header)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// Commit row using TanStack cells with drag-to-reorder on non-graph columns
function CommitRow({
  row,
  selected,
  onClick,
  onContextMenu,
  y,
  draggingColumnId,
  onColumnDragStart,
  onColumnDragOver,
  onColumnDrop,
}: {
  row: ReturnType<ReturnType<typeof useReactTable<LayoutNode>>["getRowModel"]>["rows"][number];
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  y: number;
  draggingColumnId: string | null;
  onColumnDragStart: (columnId: string) => void;
  onColumnDragOver: (e: React.DragEvent, columnId: string) => void;
  onColumnDrop: (columnId: string) => void;
}) {
  const isVirtual = !!row.original.commit.uncommitted;

  return (
    <div
      className={cn(
        "absolute right-0 left-0 flex h-8 cursor-pointer items-center text-xs transition-colors duration-100",
        selected ? "bg-primary" : "hover:bg-primary/50",
      )}
      style={{ top: y - 16 }}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {row.getVisibleCells().map((cell) => {
        const isSubject = cell.column.id === "subject";
        const isGraph = cell.column.id === "graph";
        const canDrag = !isGraph;
        const isDragging = draggingColumnId === cell.column.id;
        const isDropTarget =
          draggingColumnId !== null && canDrag && draggingColumnId !== cell.column.id;

        if (isGraph) {
          return (
            <div key={cell.id} style={{ width: cell.column.getSize() }} className="shrink-0" />
          );
        }

        // Virtual uncommitted rows: show edit icon in hash, italic message, blank author/date
        if (isVirtual) {
          if (cell.column.id === "hash") {
            return (
              <div
                key={cell.id}
                style={{ width: cell.column.getSize() }}
                className="text-muted-foreground flex shrink-0 items-center justify-center px-1.5"
              >
                <PencilLineIcon className="size-3" />
              </div>
            );
          }
          if (isSubject) {
            return (
              <span
                key={cell.id}
                className={cn(
                  "text-muted-foreground min-w-0 flex-1 truncate px-1.5 italic",
                  isDragging && "opacity-50",
                )}
                title={row.original.commit.message}
              >
                {row.original.commit.message}
              </span>
            );
          }
          // author, date — empty for uncommitted
          return (
            <div
              key={cell.id}
              style={{ width: cell.column.getSize() }}
              className="shrink-0 px-1.5"
            />
          );
        }

        if (isSubject) {
          return (
            <span
              key={cell.id}
              draggable
              onDragStart={() => onColumnDragStart(cell.column.id)}
              onDragOver={(e) => onColumnDragOver(e, cell.column.id)}
              onDrop={() => onColumnDrop(cell.column.id)}
              className={cn(
                "text-foreground min-w-0 flex-1 truncate px-1.5",
                isDragging && "opacity-50",
                isDropTarget && "border-primary/50 border-l-2",
              )}
              title={cell.getValue() as string}
            >
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </span>
          );
        }

        return (
          <div
            key={cell.id}
            draggable
            onDragStart={() => onColumnDragStart(cell.column.id)}
            onDragOver={(e) => onColumnDragOver(e, cell.column.id)}
            onDrop={() => onColumnDrop(cell.column.id)}
            style={{ width: cell.column.getSize() }}
            className={cn(
              "text-muted-foreground shrink-0 px-1.5",
              cell.column.id === "hash" && "font-mono",
              cell.column.id === "author" && "truncate",
              cell.column.id === "date" && "text-right",
              isDragging && "opacity-50",
              isDropTarget && "border-primary/50 border-l-2",
            )}
            title={cell.column.id === "author" ? (cell.getValue() as string) : undefined}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </div>
        );
      })}
    </div>
  );
}

/** Get the branch name associated with an uncommitted row via its parent commit's refs */
function getUncommittedBranch(commit: CommitInfo, allCommits: CommitInfo[]): string | null {
  if (!commit.uncommitted) return null;
  const parentHash = commit.parents[0];
  const parent = allCommits.find((c) => c.hash === parentHash);
  if (!parent) return null;
  const ref =
    parent.refs.find((r) => r.type === "head") ?? parent.refs.find((r) => r.type === "remote");
  return ref?.name ?? null;
}

export function CommitGraph() {
  const enrichedCommits = useCommitsWithUncommitted();
  const branchFilterPreset = useWorktreeUI((s) => s.branchFilterPreset);
  const { data: commitsData } = useCommitsQuery(branchFilterPreset);
  const rawCommits = commitsData?.commits ?? [];
  const selectedCommits = useRepositoryStore((s) => s.selectedCommits);
  const selectCommit = useRepositoryStore((s) => s.selectCommit);
  const selectCommitRange = useRepositoryStore((s) => s.selectCommitRange);
  const searchQuery = useWorktreeUI((s) => s.searchQuery);

  const containerRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{
    open: boolean;
    position: { x: number; y: number };
    commitHash: string;
  }>({ open: false, position: { x: 0, y: 0 }, commitHash: "" });

  const searchFilters = useWorktreeUI((s) => s.searchFilters);

  // Column state from Zustand — scoped per project+worktree via snapshot system
  const columnSizing = useWorktreeUI((s) => s.graphColumnSizing);
  const setGraphColumnSizing = useWorktreeUI((s) => s.setGraphColumnSizing);
  const columnOrder = useWorktreeUI((s) => s.graphColumnOrder);
  const setGraphColumnOrder = useWorktreeUI((s) => s.setGraphColumnOrder);
  const [columnVisibility] = useState<VisibilityState>({});

  // Column drag state for reordering
  const [draggingColumnId, setDraggingColumnId] = useState<string | null>(null);

  // Filter commits by search query and filters
  const filteredCommits = useMemo(() => {
    let result = enrichedCommits;

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter((c) => {
        if (c.uncommitted) {
          return query === "uncommitted" || c.message.toLowerCase().includes(query);
        }
        return (
          c.message.toLowerCase().includes(query) ||
          c.author.toLowerCase().includes(query) ||
          c.hash.toLowerCase().startsWith(query) ||
          c.refs.some((r) => r.name.toLowerCase().includes(query))
        );
      });
    }

    if (searchFilters.branches.length > 0) {
      result = result.filter((c) => {
        if (c.uncommitted) {
          const branch = getUncommittedBranch(c, enrichedCommits);
          return branch !== null && searchFilters.branches.some((b) => branch.includes(b));
        }
        return c.refs.some((r) => searchFilters.branches.some((b) => r.name.includes(b)));
      });
    }

    if (searchFilters.users.length > 0) {
      result = result.filter((c) => !c.uncommitted && searchFilters.users.includes(c.author));
    }

    if (searchFilters.dateRange !== "all") {
      const now = new Date();
      let cutoff: Date;
      switch (searchFilters.dateRange) {
        case "today":
          cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          break;
        case "7d":
          cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case "30d":
          cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        case "custom":
          cutoff = new Date(0);
          break;
        default: {
          const _exhaustive: never = searchFilters.dateRange;
          throw new Error(`Unknown dateRange: ${String(_exhaustive)}`);
        }
      }
      result = result.filter((c) => !c.uncommitted && new Date(c.authorDate) >= cutoff);
    }

    if (searchFilters.paths) {
      // Path filtering would typically require backend integration
    }

    return result;
  }, [enrichedCommits, searchQuery, searchFilters]);

  // Calculate layout
  const layout = useMemo(() => calculateLayout(filteredCommits), [filteredCommits]);

  // Build columns with dynamic graph width
  const columns = useMemo(() => buildColumns(layout.width), [layout.width]);

  const handleColumnSizingChange = useCallback(
    (updater: ColumnSizingState | ((old: ColumnSizingState) => ColumnSizingState)) => {
      const prev = getCurrentWorktreeUI().getState().graphColumnSizing;
      const next = typeof updater === "function" ? updater(prev) : updater;
      setGraphColumnSizing(next);
    },
    [setGraphColumnSizing],
  );

  const handleColumnOrderChange = useCallback(
    (updater: ColumnOrderState | ((old: ColumnOrderState) => ColumnOrderState)) => {
      const prev = getCurrentWorktreeUI().getState().graphColumnOrder;
      const next = typeof updater === "function" ? updater(prev) : updater;
      setGraphColumnOrder(next);
    },
    [setGraphColumnOrder],
  );

  const table = useReactTable({
    data: layout.nodes,
    columns,
    columnResizeMode: "onChange",
    state: { columnSizing, columnOrder, columnVisibility },
    onColumnSizingChange: handleColumnSizingChange,
    onColumnOrderChange: handleColumnOrderChange,
    getCoreRowModel: getCoreRowModel(),
  });

  // Set the graph column to the computed layout width only on first visit
  // (no saved sizing). After that, the user's resize is preserved.
  useEffect(() => {
    if (getCurrentWorktreeUI().getState().graphColumnSizing.graph === undefined) {
      table.setColumnSizing((prev) => ({ ...prev, graph: layout.width + REF_LABELS_WIDTH }));
    }
  }, [table, layout.width]);

  // Column drag-to-reorder handlers
  const handleColumnDragStart = useCallback((columnId: string) => {
    setDraggingColumnId(columnId);
  }, []);

  const handleColumnDragOver = useCallback((e: React.DragEvent, _columnId: string) => {
    e.preventDefault();
  }, []);

  const handleColumnDrop = useCallback(
    (toId: string) => {
      if (draggingColumnId && draggingColumnId !== toId) {
        const currentOrder = table.getState().columnOrder;
        const order =
          currentOrder.length > 0 ? [...currentOrder] : table.getAllColumns().map((c) => c.id);

        const fromIndex = order.indexOf(draggingColumnId);
        const toIndex = order.indexOf(toId);
        if (fromIndex !== -1 && toIndex !== -1) {
          order.splice(fromIndex, 1);
          order.splice(toIndex, 0, draggingColumnId);
          handleColumnOrderChange(order);
        }
      }
      setDraggingColumnId(null);
    },
    [draggingColumnId, table, handleColumnOrderChange],
  );

  const handleCommitClick = useCallback(
    (hash: string, e: React.MouseEvent) => {
      if (e.shiftKey) {
        selectCommitRange(hash, filteredCommits);
      } else {
        selectCommit(hash, e.metaKey || e.ctrlKey);
      }
    },
    [selectCommit, selectCommitRange, filteredCommits],
  );

  const handleContextMenu = useCallback((hash: string, e: React.MouseEvent) => {
    e.preventDefault();
    // Suppress context menu for virtual uncommitted commits
    if (isUncommittedHash(hash)) return;
    setContextMenu({ open: true, position: { x: e.clientX, y: e.clientY }, commitHash: hash });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, open: false }));
  }, []);

  if (filteredCommits.length === 0) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        {rawCommits.length === 0 ? "No commits" : "No matching commits"}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative flex h-full scrollbar-thin flex-col overflow-hidden select-none"
      onDragEnd={() => setDraggingColumnId(null)}
    >
      {/* Scrollable content */}
      <div className="relative flex-1 scrollbar-thin overflow-auto">
        <div className="relative" style={{ height: layout.height, minHeight: "100%" }}>
          {/* HTML layer for commit rows (behind SVG so backgrounds don't cover graph lines) */}
          {table.getRowModel().rows.map((row) => {
            const node = row.original;
            return (
              <CommitRow
                key={node.commit.hash}
                row={row}
                y={node.y}
                selected={selectedCommits.has(node.commit.hash)}
                onClick={(e) => handleCommitClick(node.commit.hash, e)}
                onContextMenu={(e) => handleContextMenu(node.commit.hash, e)}
                draggingColumnId={draggingColumnId}
                onColumnDragStart={handleColumnDragStart}
                onColumnDragOver={handleColumnDragOver}
                onColumnDrop={handleColumnDrop}
              />
            );
          })}

          {/* SVG layer for graph lines and nodes (on top, pointer-events pass through to rows) */}
          <svg
            className="pointer-events-none absolute top-0 left-0"
            style={{
              width: table.getColumn("graph")?.getSize() ?? layout.width + REF_LABELS_WIDTH,
              height: layout.height,
            }}
          >
            {/* Edges (lines) */}
            <g>
              {layout.edges.map((edge, i) => (
                <BranchLine key={i} edge={edge} />
              ))}
            </g>

            {/* Nodes (circles) */}
            <g>
              {layout.nodes.map((node) => (
                <CommitNode
                  key={node.commit.hash}
                  commit={node.commit}
                  x={node.x}
                  y={node.y}
                  color={node.color}
                  selected={selectedCommits.has(node.commit.hash)}
                  graphColumnWidth={
                    table.getColumn("graph")?.getSize() ?? layout.width + REF_LABELS_WIDTH
                  }
                />
              ))}
            </g>
          </svg>
        </div>
      </div>

      {/* Full-height column resize handles */}
      <ColumnResizeOverlay table={table} />

      {/* Context menu */}
      <CommitContextMenu
        open={contextMenu.open}
        position={contextMenu.position}
        commitHash={contextMenu.commitHash}
        onClose={handleCloseContextMenu}
      />
    </div>
  );
}
