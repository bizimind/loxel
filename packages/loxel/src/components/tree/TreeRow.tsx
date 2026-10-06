import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";

import { FileTypeIcon } from "@/lib/file-icons";
import { cn } from "@/lib/utils";

export const TREE_INDENT_BASE = 8;
export const TREE_INDENT_STEP = 16;

export const TREE_PATH_ATTR = "data-tree-path";
/** The row's displayed name, matched by type-ahead. */
export const TREE_NAME_ATTR = "data-tree-name";
/**
 * Marks a group of rows (e.g. Project Files' Drafts, worktree and Others sections). Root rows of
 * different sections are not siblings for keyboard navigation.
 */
export const TREE_SECTION_ATTR = "data-tree-section";

interface TreeRowProps {
  path: string;
  name: string;
  depth: number;
  isDir: boolean;
  isExpanded?: boolean;
  isSelected?: boolean;
  isActive?: boolean;
  isPanelActive?: boolean;
  isLoading?: boolean;

  label?: ReactNode;
  labelClassName?: string;
  trailing?: ReactNode;
  buttonProps?: HTMLAttributes<HTMLButtonElement>;
  buttonClassName?: string;

  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export function TreeRow({
  path,
  name,
  depth,
  isDir,
  isExpanded,
  isSelected,
  isActive,
  isPanelActive,
  isLoading,
  label,
  labelClassName,
  trailing,
  buttonProps,
  buttonClassName,
  onClick,
  onDoubleClick,
  onContextMenu,
}: TreeRowProps) {
  const indentPx = TREE_INDENT_BASE + depth * TREE_INDENT_STEP;

  return (
    <div className="px-1">
      <button
        {...buttonProps}
        {...{ [TREE_PATH_ATTR]: path, [TREE_NAME_ATTR]: name }}
        {...(isDir ? { "data-tree-dir": "" } : undefined)}
        {...(isDir && isExpanded ? { "data-tree-expanded": "" } : undefined)}
        {...(isSelected ? { "data-tree-selected": "" } : undefined)}
        {...(isActive ? { "data-tree-active": "" } : undefined)}
        data-tree-depth={depth}
        tabIndex={-1}
        // Hover is a light tint; the focused row (by keyboard or click) is a stronger tint with an
        // outline, so the two never look alike. The active row keeps its own background.
        className={cn(
          "focus:ring-ring flex w-full items-center gap-1.5 rounded-md py-1 pr-3 text-left text-xs outline-0 focus:ring-1 focus:ring-inset",
          isActive
            ? isPanelActive
              ? "bg-primary hover:bg-primary focus:bg-primary"
              : "bg-muted hover:bg-muted focus:bg-muted"
            : // Light --primary is pale, so it needs stronger tints than the dark theme.
              "hover:bg-primary/40 focus:bg-primary/80 dark:hover:bg-primary/20 dark:focus:bg-primary/50",
          buttonClassName,
        )}
        style={{ paddingLeft: indentPx, ...buttonProps?.style }}
        onClick={(e) => {
          // Clicking a row makes it the keyboard focus, so arrow keys continue from it. Focus
          // already inside the row (its rename input) stays put.
          if (!e.currentTarget.contains(document.activeElement)) {
            e.currentTarget.focus({ preventScroll: true });
          }
          onClick?.();
        }}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {isDir ? (
            isExpanded ? (
              <ChevronDownIcon className="text-muted-foreground size-3.5" />
            ) : (
              <ChevronRightIcon className="text-muted-foreground size-3.5" />
            )
          ) : null}
        </span>
        <FileTypeIcon filename={name} isFolder={isDir} className="size-3.5 shrink-0" />
        {label ?? (
          <span
            className={cn("min-w-0 flex-1 truncate", isDir && "text-tree-folder", labelClassName)}
          >
            {name}
          </span>
        )}
        {isLoading && <span className="text-muted-foreground text-[10px]">...</span>}
        {trailing}
      </button>
    </div>
  );
}
