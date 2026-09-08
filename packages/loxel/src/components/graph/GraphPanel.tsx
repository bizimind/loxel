import type {
  DockviewApi,
  DockviewReadyEvent,
  IDockviewPanelHeaderProps,
  IDockviewPanelProps,
} from "dockview-react";
import { DockviewReact } from "dockview-react";
import {
  CalendarIcon,
  ChevronDownIcon,
  FilterIcon,
  GitBranchIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PlusIcon,
  SearchIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BranchPanel } from "@/components/panels/BranchPanel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { detectPanelSide } from "@/lib/dockview-utils";
import { cn } from "@/lib/utils";
import { useCreateBranchMutation } from "@/queries/use-git-mutations";
import { useBranchesQuery, useCommitsQuery } from "@/queries/use-repo-queries";
import { getWorktreeInnerLayout, setWorktreeInnerLayout } from "@/store/worktree-cache";
import {
  type BranchFilterPreset,
  type DateRangePreset,
  getCurrentWorktreeUI,
  useWorktreeUI,
} from "@/store/worktree-ui";

import { CommitGraph } from "./CommitGraph";

const FILTER_LABELS: Record<BranchFilterPreset, string> = {
  all: "All branches",
  "current-and-main": "Current + main",
  "recent-1d": "Recent (1 day)",
  "recent-2d": "Recent (2 days)",
  "recent-3d": "Recent (3 days)",
  "recent-5d": "Recent (5 days)",
};

const DATE_RANGE_LABELS: Record<DateRangePreset, string> = {
  all: "All time",
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  custom: "Custom range",
};

// --- Inner panel components for nested dockview ---

function InnerBranches(_props: IDockviewPanelProps) {
  const collapsed = useWorktreeUI((s) => s.branchesPanelCollapsed);

  if (collapsed) {
    return <div className="h-full" />;
  }

  return (
    <div className="h-full overflow-hidden">
      <BranchPanel hideHeader />
    </div>
  );
}

function InnerGraphContent(_props: IDockviewPanelProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <GraphPanelHeader />
      <div className="min-h-0 flex-1">
        <CommitGraph />
      </div>
    </div>
  );
}

// Custom tab for the branches panel — renders as a full-width header with title + create/collapse buttons
function BranchesTab(_props: IDockviewPanelHeaderProps) {
  const createBranchMutation = useCreateBranchMutation();
  const collapsed = useWorktreeUI((s) => s.branchesPanelCollapsed);
  const toggle = useWorktreeUI((s) => s.toggleBranchesPanel);
  const side = useWorktreeUI((s) => s.branchesPanelSide);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");

  const handleCreate = async () => {
    if (!newBranchName.trim()) return;
    await createBranchMutation.mutateAsync({ name: newBranchName.trim() });
    setNewBranchName("");
    setShowCreateForm(false);
  };

  if (collapsed) {
    const OpenIcon = side === "left" ? PanelLeftOpenIcon : PanelRightOpenIcon;
    return (
      <div
        className="flex h-full w-full cursor-pointer flex-col items-center gap-2 py-2"
        onClick={toggle}
        title="Show branches"
      >
        <OpenIcon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="text-muted-foreground text-[11px] [writing-mode:vertical-lr]">
          Branches
        </span>
      </div>
    );
  }

  const CloseIcon = side === "left" ? PanelLeftCloseIcon : PanelRightCloseIcon;
  return (
    <div className="flex w-full flex-col">
      <div className="flex items-center justify-between px-3 py-1.5">
        <h2 className="text-foreground text-sm font-medium">Branches</h2>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={(e) => {
              e.stopPropagation();
              setShowCreateForm(!showCreateForm);
            }}
            title="Create branch"
          >
            <PlusIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
            title="Hide branches"
          >
            <CloseIcon />
          </Button>
        </div>
      </div>
      {showCreateForm && (
        <div className="border-border flex gap-1 border-t px-2 py-1.5">
          <Input
            autoFocus
            placeholder="New branch name"
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
              if (e.key === "Escape") setShowCreateForm(false);
            }}
            className="h-6 text-xs"
          />
          <Button
            variant="secondary"
            size="xs"
            onClick={handleCreate}
            disabled={!newBranchName.trim()}
          >
            Create
          </Button>
        </div>
      )}
    </div>
  );
}

const innerComponents = { innerBranches: InnerBranches, innerGraphContent: InnerGraphContent };
const innerTabComponents = { branchesTab: BranchesTab };

const COLLAPSED_WIDTH = 28;
const BRANCHES_DEFAULT_WIDTH = 220;

// --- Main GraphPanel ---

export function GraphPanel() {
  const branchesPanelCollapsed = useWorktreeUI((s) => s.branchesPanelCollapsed);

  const innerApiRef = useRef<DockviewApi | null>(null);
  const savedWidthRef = useRef(BRANCHES_DEFAULT_WIDTH);

  // Collapse/expand the branches panel by resizing and locking constraints
  useEffect(() => {
    const api = innerApiRef.current;
    if (!api) return;
    const panel = api.getPanel("innerBranches");
    if (!panel?.group) return;

    if (branchesPanelCollapsed) {
      const currentWidth = panel.group.api.width;
      if (currentWidth > COLLAPSED_WIDTH) savedWidthRef.current = currentWidth;
      panel.group.api.setConstraints({
        minimumWidth: COLLAPSED_WIDTH,
        maximumWidth: COLLAPSED_WIDTH,
      });
      panel.group.api.setSize({ width: COLLAPSED_WIDTH });
    } else {
      panel.group.api.setConstraints({ minimumWidth: 0, maximumWidth: Number.MAX_SAFE_INTEGER });
      requestAnimationFrame(() => {
        panel.group.api.setSize({ width: savedWidthRef.current });
      });
    }
  }, [branchesPanelCollapsed]);

  const onInnerReady = useCallback((event: DockviewReadyEvent) => {
    const { api } = event;
    innerApiRef.current = api;

    // Restore saved inner layout (panel sizes, positions) or create default
    const savedLayout = getWorktreeInnerLayout("graph");
    if (savedLayout && api.panels.length === 0) {
      api.fromJSON(savedLayout);
    } else if (api.panels.length === 0) {
      const uiState = getCurrentWorktreeUI().getState();
      api.addPanel({ id: "innerGraphContent", component: "innerGraphContent", title: "Graph" });
      api.addPanel({
        id: "innerBranches",
        component: "innerBranches",
        tabComponent: "branchesTab",
        title: "Branches",
        position: { referencePanel: "innerGraphContent", direction: uiState.branchesPanelSide },
        initialWidth: uiState.branchesPanelCollapsed ? COLLAPSED_WIDTH : BRANCHES_DEFAULT_WIDTH,
      });
    }
    // These imperative properties aren't serialized by toJSON — re-apply after any load
    const graphContentPanel = api.getPanel("innerGraphContent");
    if (graphContentPanel?.group) {
      graphContentPanel.group.header.hidden = true;
      graphContentPanel.group.locked = "no-drop-target";
    }
    // Restrict docking to left/right only
    api.onWillShowOverlay((e) => {
      if (e.position !== "left" && e.position !== "right") {
        e.preventDefault();
      }
    });
    // Track side when user drags the panel and re-apply constraints after drag
    // (dragging creates a new group, losing the old min/max lock and size)
    api.onDidLayoutChange(() => {
      const newSide = detectPanelSide(api, "innerBranches", "innerGraphContent");
      const prevSide = getCurrentWorktreeUI().getState().branchesPanelSide;
      getCurrentWorktreeUI().getState().setBranchesPanelSide(newSide);
      const panel = api.getPanel("innerBranches");
      if (!panel?.group) return;
      if (
        getCurrentWorktreeUI().getState().branchesPanelCollapsed &&
        panel.group.api.width > COLLAPSED_WIDTH
      ) {
        panel.group.api.setConstraints({
          minimumWidth: COLLAPSED_WIDTH,
          maximumWidth: COLLAPSED_WIDTH,
        });
        panel.group.api.setSize({ width: COLLAPSED_WIDTH });
      } else if (!getCurrentWorktreeUI().getState().branchesPanelCollapsed) {
        if (newSide !== prevSide) {
          panel.group.api.setSize({ width: savedWidthRef.current });
        } else {
          savedWidthRef.current = panel.group.api.width;
        }
      }

      setWorktreeInnerLayout("graph", api.toJSON());
    });
  }, []);

  return (
    <DockviewReact
      className="dockview-theme-abyss dockview-inner h-full"
      components={innerComponents}
      tabComponents={innerTabComponents}
      singleTabMode="fullwidth"
      scrollbars="native"
      onReady={onInnerReady}
    />
  );
}

function GraphPanelHeader() {
  const searchQuery = useWorktreeUI((s) => s.searchQuery);
  const setSearchQuery = useWorktreeUI((s) => s.setSearchQuery);
  const branchFilterPreset = useWorktreeUI((s) => s.branchFilterPreset);
  const setBranchFilterPreset = useWorktreeUI((s) => s.setBranchFilterPreset);
  const searchFilters = useWorktreeUI((s) => s.searchFilters);
  const setSearchFilters = useWorktreeUI((s) => s.setSearchFilters);

  const { data: commitsData } = useCommitsQuery(branchFilterPreset);
  const commits = commitsData?.commits ?? [];
  const { data: branches } = useBranchesQuery();
  const branchList = branches ?? [];

  const uniqueAuthors = useMemo(() => {
    const authors = new Set<string>();
    for (const commit of commits) {
      authors.add(commit.author);
    }
    return Array.from(authors).sort();
  }, [commits]);

  const branchNames = useMemo(() => branchList.map((b) => b.name).sort(), [branchList]);

  const activeFilterCount =
    searchFilters.branches.length +
    searchFilters.users.length +
    (searchFilters.dateRange !== "all" ? 1 : 0);

  return (
    <div className="border-border bg-card flex h-9 shrink-0 items-center gap-2 border-b px-2">
      {/* Search input */}
      <div className="relative max-w-48 flex-1">
        <SearchIcon className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
        <Input
          placeholder="Search commits..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-7 pl-8 text-xs"
        />
      </div>

      {/* Filter dropdowns */}
      <div className="flex items-center gap-1">
        {/* Branch filter */}
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              "hover:bg-muted flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors",
              searchFilters.branches.length > 0 && "bg-primary/10 text-primary",
            )}
            title="Filter by branch"
          >
            <GitBranchIcon className="size-3.5" />
            <span className="hidden sm:inline">Branch</span>
            {searchFilters.branches.length > 0 && (
              <span className="bg-primary text-primary-foreground rounded px-1 text-[10px]">
                {searchFilters.branches.length}
              </span>
            )}
            <ChevronDownIcon className="text-muted-foreground size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-64 w-56 overflow-y-auto">
            {branchNames.length === 0 ? (
              <div className="text-muted-foreground px-2 py-1.5 text-xs">No branches</div>
            ) : (
              <>
                <DropdownMenuCheckboxItem
                  checked={searchFilters.branches.length === 0}
                  onCheckedChange={() => setSearchFilters({ branches: [] })}
                >
                  All
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                {branchNames.map((name) => (
                  <DropdownMenuCheckboxItem
                    key={name}
                    checked={searchFilters.branches.includes(name)}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        setSearchFilters({ branches: [...searchFilters.branches, name] });
                      } else {
                        setSearchFilters({
                          branches: searchFilters.branches.filter((b) => b !== name),
                        });
                      }
                    }}
                  >
                    <span className="truncate">{name}</span>
                  </DropdownMenuCheckboxItem>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* User filter */}
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              "hover:bg-muted flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors",
              searchFilters.users.length > 0 && "bg-primary/10 text-primary",
            )}
            title="Filter by author"
          >
            <UserIcon className="size-3.5" />
            <span className="hidden sm:inline">User</span>
            {searchFilters.users.length > 0 && (
              <span className="bg-primary text-primary-foreground rounded px-1 text-[10px]">
                {searchFilters.users.length}
              </span>
            )}
            <ChevronDownIcon className="text-muted-foreground size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-64 w-56 overflow-y-auto">
            {uniqueAuthors.length === 0 ? (
              <div className="text-muted-foreground px-2 py-1.5 text-xs">No authors</div>
            ) : (
              <>
                <DropdownMenuCheckboxItem
                  checked={searchFilters.users.length === 0}
                  onCheckedChange={() => setSearchFilters({ users: [] })}
                >
                  All
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                {uniqueAuthors.map((author) => (
                  <DropdownMenuCheckboxItem
                    key={author}
                    checked={searchFilters.users.includes(author)}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        setSearchFilters({ users: [...searchFilters.users, author] });
                      } else {
                        setSearchFilters({
                          users: searchFilters.users.filter((u) => u !== author),
                        });
                      }
                    }}
                  >
                    <span className="truncate">{author}</span>
                  </DropdownMenuCheckboxItem>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Date filter */}
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              "hover:bg-muted flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors",
              searchFilters.dateRange !== "all" && "bg-primary/10 text-primary",
            )}
            title="Filter by date"
          >
            <CalendarIcon className="size-3.5" />
            <span className="hidden sm:inline">Date</span>
            <ChevronDownIcon className="text-muted-foreground size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuRadioGroup
              value={searchFilters.dateRange}
              onValueChange={(v) => setSearchFilters({ dateRange: v as DateRangePreset })}
            >
              <DropdownMenuRadioItem value="all">{DATE_RANGE_LABELS.all}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="today">{DATE_RANGE_LABELS.today}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="7d">{DATE_RANGE_LABELS["7d"]}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="30d">{DATE_RANGE_LABELS["30d"]}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Clear filters */}
        {activeFilterCount > 0 && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => getCurrentWorktreeUI().getState().resetSearchFilters()}
            title="Clear all filters"
            className="text-muted-foreground hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </Button>
        )}
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-1">
        {/* Branch filter preset (graph display) */}
        <DropdownMenu>
          <DropdownMenuTrigger
            className="hover:bg-muted flex h-7 items-center gap-1.5 rounded-md px-2 text-xs"
            title="Filter branches"
          >
            <FilterIcon className="size-3.5" />
            <span className="max-w-24 truncate">{FILTER_LABELS[branchFilterPreset]}</span>
            <ChevronDownIcon className="text-muted-foreground size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48 rounded-md p-1">
            <DropdownMenuRadioGroup
              value={branchFilterPreset}
              onValueChange={(v) => setBranchFilterPreset(v as BranchFilterPreset)}
            >
              <DropdownMenuRadioItem value="all">{FILTER_LABELS.all}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="current-and-main">
                {FILTER_LABELS["current-and-main"]}
              </DropdownMenuRadioItem>
              <DropdownMenuSeparator />
              <DropdownMenuRadioItem value="recent-1d">
                {FILTER_LABELS["recent-1d"]}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="recent-2d">
                {FILTER_LABELS["recent-2d"]}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="recent-3d">
                {FILTER_LABELS["recent-3d"]}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="recent-5d">
                {FILTER_LABELS["recent-5d"]}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
