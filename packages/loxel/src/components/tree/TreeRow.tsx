import type { HTMLAttributes, ReactNode } from "react";

import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import { FileTypeIcon } from "@/lib/file-icons";
import { cn } from "@/lib/utils";

export const TREE_INDENT_BASE = 8;
export const TREE_INDENT_STEP = 16;

export const TREE_PATH_ATTR = "data-tree-path";

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
        {...{ [TREE_PATH_ATTR]: path }}
        {...(isDir ? { "data-tree-dir": "" } : undefined)}
        {...(isDir && isExpanded ? { "data-tree-expanded": "" } : undefined)}
        {...(isSelected ? { "data-tree-selected": "" } : undefined)}
        {...(isActive ? { "data-tree-active": "" } : undefined)}
        data-tree-depth={depth}
        tabIndex={-1}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md py-1 pr-3 text-left text-xs outline-0",
          isActive
            ? isPanelActive
              ? "bg-primary hover:bg-primary focus-visible:bg-primary"
              : "bg-muted hover:bg-muted focus-visible:bg-muted"
            : "hover:bg-primary/50 focus-visible:bg-primary/50",
          buttonClassName,
        )}
        style={{ paddingLeft: indentPx, ...buttonProps?.style }}
        onClick={onClick}
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
