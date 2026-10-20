import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/store/ui";

/** Previous/next navigation over the files of a multi-file diff */
export interface DiffFileNavigation {
  /** 0-based index of the shown file, -1 when it is not in the list */
  index: number;
  count: number;
  onPrevious: () => void;
  onNext: () => void;
}

/**
 * Toolbar of diff panels: file navigation when the diff has several files, change navigation,
 * and the split/unified toggle (a global setting shared by every diff panel).
 */
export function DiffToolbar({ fileNavigation }: { fileNavigation?: DiffFileNavigation }) {
  const viewMode = useUIStore((s) => s.diffViewMode);
  const setDiffViewMode = useUIStore((s) => s.setDiffViewMode);

  return (
    <div className="border-border bg-muted/30 flex items-center gap-1 border-b px-2 py-1">
      {fileNavigation && (
        <>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={fileNavigation.onPrevious}
            disabled={fileNavigation.index <= 0}
            title="Previous file"
          >
            <ArrowLeftIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={fileNavigation.onNext}
            disabled={fileNavigation.index >= fileNavigation.count - 1}
            title="Next file"
          >
            <ArrowRightIcon className="size-3.5" />
          </Button>
          <div className="bg-border mx-1 h-4 w-px" />
        </>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        title="Previous change (coming soon)"
        disabled
        className="text-muted-foreground/50"
      >
        <ArrowUpIcon className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        title="Next change (coming soon)"
        disabled
        className="text-muted-foreground/50"
      >
        <ArrowDownIcon className="size-3.5" />
      </Button>
      {fileNavigation && (
        <span className="text-muted-foreground ml-2 text-[10px]">
          File {fileNavigation.index + 1} of {fileNavigation.count}
        </span>
      )}

      <div className="flex-1" />

      {/* View mode segmented toggle */}
      <div className="bg-muted flex h-6 items-center rounded-md p-0.5 text-[10px]">
        <button
          className={cn(
            "rounded px-2 py-0.5 transition-colors",
            viewMode === "unified"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setDiffViewMode("unified")}
        >
          Unified
        </button>
        <button
          className={cn(
            "rounded px-2 py-0.5 transition-colors",
            viewMode === "split"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setDiffViewMode("split")}
        >
          Split
        </button>
      </div>
    </div>
  );
}
