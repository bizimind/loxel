import { ChevronDownIcon, ListChecksIcon } from "lucide-react";
import { useMemo } from "react";

import type { CommitInfo } from "@/api/git-models";

import { UNCOMMITTED_PREFIX } from "@/api/git-models";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getBranchColor } from "@/lib/colors";
import { dayjs } from "@/lib/dayjs";
import { createVirtualCommit } from "@/lib/uncommitted-commits";
import { cn } from "@/lib/utils";
import { useBranchCommitsQuery, useWorktreeStatusesQuery } from "@/queries/use-repo-queries";
import { useRepositoryStore } from "@/store/worktree-repository";
import { useWorktreeStore } from "@/store/worktrees";

/**
 * Layout constants — same approach as the main Git graph (layout.ts).
 * Fixed row height ensures SVG dot/line positions align with HTML rows.
 */
const ROW_HEIGHT = 40;
const GRAPH_WIDTH = 20;
const CX = GRAPH_WIDTH / 2;
const DOT_RADIUS = 5;
const LINE_STROKE = 2;

type SelectionMode = "default" | "branch" | "external";

export function BranchCommitDropdown() {
  const { data: branchData } = useBranchCommitsQuery();
  const { data: worktreeStatuses } = useWorktreeStatusesQuery();
  const activeWorktreePath = useWorktreeStore((s) => s.activeWorktreePath);
  const selectedCommits = useRepositoryStore((s) => s.selectedCommits);
  const selectCommit = useRepositoryStore((s) => s.selectCommit);
  const selectCommitRange = useRepositoryStore((s) => s.selectCommitRange);
  const setSelectedCommits = useRepositoryStore((s) => s.setSelectedCommits);

  const branchCommits = branchData?.commits ?? [];

  const dropdownCommits: CommitInfo[] = useMemo(() => {
    if (!activeWorktreePath) return branchCommits;

    const activeStatus = worktreeStatuses?.find((wt) => wt.path === activeWorktreePath);
    const headCommit = activeStatus?.commit ?? branchCommits[0]?.hash ?? "";
    const branch = activeStatus?.branch ?? null;

    const virtual = createVirtualCommit(
      headCommit,
      activeWorktreePath,
      branch,
      activeStatus?.staged.length ?? 0,
      activeStatus?.unstaged.length ?? 0,
      activeStatus?.untracked.length ?? 0,
    );

    return [virtual, ...branchCommits];
  }, [branchCommits, worktreeStatuses, activeWorktreePath]);

  const uncommittedHash = activeWorktreePath ? `${UNCOMMITTED_PREFIX}${activeWorktreePath}` : null;

  const hasLocalChanges = useMemo(() => {
    const virtual = dropdownCommits[0];
    if (!virtual?.uncommitted) return false;
    return virtual.uncommitted.stagedCount + virtual.uncommitted.unstagedCount > 0;
  }, [dropdownCommits]);

  const branchHashes = useMemo(
    () => new Set(dropdownCommits.map((c) => c.hash)),
    [dropdownCommits],
  );

  const selectionMode: SelectionMode = useMemo(() => {
    if (selectedCommits.size === 0) return "default";
    for (const h of selectedCommits) {
      if (!branchHashes.has(h)) return "external";
    }
    return "branch";
  }, [selectedCommits, branchHashes]);

  // All branch items are selected (and nothing external)
  const allSelected =
    selectionMode === "branch" &&
    dropdownCommits.length > 0 &&
    dropdownCommits.every((c) => selectedCommits.has(c.hash));

  const triggerLabel = useMemo(() => {
    if (selectionMode === "external") return "Git graph selection";
    if (selectionMode === "default") return "Local changes";
    if (allSelected) return "All branch changes";
    const count = selectedCommits.size;
    if (count === 1 && uncommittedHash && selectedCommits.has(uncommittedHash)) {
      return "Local changes";
    }
    return count === 1 ? "1 commit" : `${count} commits`;
  }, [selectionMode, selectedCommits, uncommittedHash, allSelected]);

  const dotColor = useMemo(() => {
    const firstWithRef = dropdownCommits.find((c) => c.refs.length > 0);
    const branchName = firstWithRef?.refs.find((r) => r.type === "head")?.name;
    return branchName ? getBranchColor(branchName) : "var(--branch-1)";
  }, [dropdownCommits]);

  function handleToggleAll() {
    if (allSelected) {
      setSelectedCommits(new Set());
    } else {
      setSelectedCommits(new Set(dropdownCommits.map((c) => c.hash)));
    }
  }

  function handleItemClick(hash: string, e: React.MouseEvent) {
    e.preventDefault();
    if (selectionMode === "external") {
      selectCommit(hash);
      return;
    }
    if (e.shiftKey) {
      selectCommitRange(hash, dropdownCommits);
    } else {
      selectCommit(hash, e.metaKey || e.ctrlKey);
    }
  }

  if (dropdownCommits.length === 0) return null;

  const totalHeight = dropdownCommits.length * ROW_HEIGHT;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "text-muted-foreground hover:text-foreground flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
          "hover:bg-muted",
        )}
      >
        <span className="max-w-32 truncate">{triggerLabel}</span>
        <ChevronDownIcon className="size-3" />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="max-h-[60vh] w-fit max-w-[32rem] overflow-y-auto px-0 py-2"
      >
        <DropdownMenuCheckboxItem
          checked={allSelected}
          onCheckedChange={handleToggleAll}
          className="focus:bg-primary data-[checked]:bg-primary gap-0 rounded-none py-0"
          style={{ height: ROW_HEIGHT }}
        >
          <div className="flex shrink-0 items-center justify-center" style={{ width: GRAPH_WIDTH }}>
            <ListChecksIcon className="size-3.5" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 pl-1">
            <span className="truncate text-xs">All branch changes</span>
            <span className="text-muted-foreground text-[10px]">
              {branchCommits.length} commit{branchCommits.length !== 1 ? "s" : ""}
              {hasLocalChanges ? " and local changes" : ""}
            </span>
          </div>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <div className="relative">
          {/* HTML rows (behind SVG so row backgrounds don't cover graph lines) */}
          {dropdownCommits.map((commit) => {
            const isUncommitted = !!commit.uncommitted;
            const isChecked = selectionMode === "branch" && selectedCommits.has(commit.hash);

            return (
              <DropdownMenuCheckboxItem
                key={commit.hash}
                checked={isChecked}
                onClick={(e) => handleItemClick(commit.hash, e)}
                className="focus:bg-primary data-[checked]:bg-primary gap-0 rounded-none py-0"
                style={{ height: ROW_HEIGHT }}
              >
                {/* Spacer for graph column */}
                <div style={{ width: GRAPH_WIDTH }} className="shrink-0" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 pl-1">
                  <span
                    className={cn(
                      "truncate text-xs",
                      isUncommitted && "text-muted-foreground italic",
                    )}
                  >
                    {isUncommitted ? "Local changes" : commit.message}
                  </span>
                  <span className="text-muted-foreground text-[10px]">
                    {isUncommitted
                      ? commit.message
                      : `${commit.shortHash} \u00B7 ${dayjs(commit.authorDate).fromNow()}`}
                  </span>
                </div>
              </DropdownMenuCheckboxItem>
            );
          })}

          {/* SVG graph overlay (on top, pointer-events pass through to rows) */}
          <svg
            className="pointer-events-none absolute top-0 left-0"
            width={GRAPH_WIDTH}
            height={totalHeight}
          >
            {dropdownCommits.map((commit, i) => {
              const isUncommitted = !!commit.uncommitted;
              const cy = i * ROW_HEIGHT + ROW_HEIGHT / 2;
              const isLast = i === dropdownCommits.length - 1;

              return (
                <g key={commit.hash}>
                  {/* Line to next commit */}
                  {!isLast && (
                    <line
                      x1={CX}
                      y1={cy}
                      x2={CX}
                      y2={cy + ROW_HEIGHT}
                      stroke={dotColor}
                      strokeWidth={LINE_STROKE}
                      strokeLinecap="round"
                      strokeDasharray={isUncommitted ? "4 3" : undefined}
                    />
                  )}
                  {/* Dot */}
                  {isUncommitted ? (
                    <circle
                      cx={CX}
                      cy={cy}
                      r={DOT_RADIUS}
                      fill="var(--popover)"
                      stroke={dotColor}
                      strokeWidth={LINE_STROKE}
                      strokeDasharray="3 2"
                    />
                  ) : (
                    <circle cx={CX} cy={cy} r={DOT_RADIUS} fill={dotColor} />
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
