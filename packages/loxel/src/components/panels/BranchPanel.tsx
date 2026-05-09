import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  GitBranchIcon,
  GlobeIcon,
  PlusIcon,
  StarIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { BranchInfo, RefInfo } from "@/api/git-models";

import { BranchContextMenu } from "@/components/menus/BranchMenu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useCreateBranchMutation } from "@/queries/use-git-mutations";
import { useBranchesQuery, useCommitsQuery } from "@/queries/use-repo-queries";
import { useUIStore } from "@/store/ui";
import { useWorktreeUI } from "@/store/worktree-ui";

// Indentation constants for consistent alignment
const INDENT_BASE = 8; // Base left padding
const INDENT_STEP = 16; // Indent per depth level
const CHEVRON_WIDTH = 16; // Width reserved for chevron

interface BranchGroup {
  prefix: string;
  branches: BranchInfo[];
}

function groupBranchesByPrefix(branches: BranchInfo[]): BranchGroup[] {
  const groups = new Map<string, BranchInfo[]>();

  for (const branch of branches) {
    const slashIndex = branch.name.indexOf("/");
    const prefix = slashIndex > 0 ? branch.name.slice(0, slashIndex) : "";
    const list = groups.get(prefix);
    if (list) {
      list.push(branch);
    } else {
      groups.set(prefix, [branch]);
    }
  }

  // Sort groups: unprefixed ("") last, then alphabetically
  return Array.from(groups.entries())
    .sort((a, b) => {
      if (a[0] === "") return 1;
      if (b[0] === "") return -1;
      return a[0].localeCompare(b[0]);
    })
    .map(([prefix, branches]) => ({
      prefix,
      branches: branches.sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

function groupRemotesByPrefix(refs: RefInfo[]): Map<string, BranchGroup[]> {
  const byRemote = new Map<string, RefInfo[]>();
  for (const ref of refs) {
    const remote = ref.remote ?? "origin";
    const list = byRemote.get(remote);
    if (list) {
      list.push(ref);
    } else {
      byRemote.set(remote, [ref]);
    }
  }

  const result = new Map<string, BranchGroup[]>();
  for (const [remote, remoteRefs] of byRemote) {
    const groups = new Map<string, BranchInfo[]>();
    for (const ref of remoteRefs) {
      // Strip remote prefix from name
      const branchName = ref.name.replace(`${remote}/`, "");
      const slashIndex = branchName.indexOf("/");
      const prefix = slashIndex > 0 ? branchName.slice(0, slashIndex) : "";
      const list = groups.get(prefix);
      // Convert RefInfo to a minimal BranchInfo for display
      const branchInfo: BranchInfo = {
        name: ref.name,
        commit: ref.commit,
        isHead: false,
        ahead: 0,
        behind: 0,
      };
      if (list) {
        list.push(branchInfo);
      } else {
        groups.set(prefix, [branchInfo]);
      }
    }

    result.set(
      remote,
      Array.from(groups.entries())
        .sort((a, b) => {
          if (a[0] === "") return 1;
          if (b[0] === "") return -1;
          return a[0].localeCompare(b[0]);
        })
        .map(([prefix, branches]) => ({
          prefix,
          branches: branches.sort((a, b) => a.name.localeCompare(b.name)),
        })),
    );
  }

  return result;
}

interface ContextMenuState {
  open: boolean;
  position: { x: number; y: number };
  branchName: string;
  isCurrentBranch: boolean;
}

export function BranchPanel({ hideHeader }: { hideHeader?: boolean }) {
  const branchFilterPreset = useWorktreeUI((s) => s.branchFilterPreset);
  const { data: branches = [] } = useBranchesQuery();
  const { data: commitsData } = useCommitsQuery(branchFilterPreset);
  const refs = commitsData?.refs ?? [];
  const createBranchMutation = useCreateBranchMutation();
  const favoriteBranches = useUIStore((s) => s.favoriteBranches);
  const toggleFavoriteBranch = useUIStore((s) => s.toggleFavoriteBranch);

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(["favorites", "head", "local", "origin"]),
  );
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    open: false,
    position: { x: 0, y: 0 },
    branchName: "",
    isCurrentBranch: false,
  });

  const remoteBranches = refs.filter((r) => r.type === "remote");
  const localGroups = useMemo(() => groupBranchesByPrefix(branches), [branches]);
  const remoteGroupsByRemote = useMemo(
    () => groupRemotesByPrefix(remoteBranches),
    [remoteBranches],
  );

  // Get favorite branches
  const favoriteBranchList = useMemo(
    () => branches.filter((b) => favoriteBranches.has(b.name)),
    [branches, favoriteBranches],
  );

  // Get current HEAD branch
  const headBranch = useMemo(() => branches.find((b) => b.isHead), [branches]);

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  const handleCreateBranch = async () => {
    if (!newBranchName.trim()) return;
    await createBranchMutation.mutateAsync({ name: newBranchName.trim() });
    setNewBranchName("");
    setShowCreateForm(false);
  };

  const handleContextMenu = (e: React.MouseEvent, branchName: string, isCurrentBranch: boolean) => {
    e.preventDefault();
    setContextMenu({
      open: true,
      position: { x: e.clientX, y: e.clientY },
      branchName,
      isCurrentBranch,
    });
  };

  const closeContextMenu = () => {
    setContextMenu((prev) => ({ ...prev, open: false }));
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {!hideHeader && (
        <>
          <div className="border-border flex items-center justify-between border-b px-3 py-2">
            <h2 className="text-foreground text-sm font-medium">Branches</h2>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setShowCreateForm(!showCreateForm)}
            >
              <PlusIcon />
            </Button>
          </div>

          {showCreateForm && (
            <div className="border-border flex gap-1 border-b p-2">
              <Input
                placeholder="New branch name"
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreateBranch()}
                className="h-7 text-xs"
                autoFocus
              />
              <Button variant="default" size="icon-xs" onClick={handleCreateBranch}>
                <CheckIcon />
              </Button>
            </div>
          )}
        </>
      )}

      <div className="flex-1 scrollbar-thin overflow-y-auto">
        {/* Favorites section (only show if there are favorites) */}
        {favoriteBranchList.length > 0 && (
          <>
            <SectionHeader
              icon={<StarIcon className="size-3.5 fill-yellow-500 text-yellow-500" />}
              title="Favorites"
              count={favoriteBranchList.length}
              expanded={expandedSections.has("favorites")}
              onToggle={() => toggleSection("favorites")}
            />
            {expandedSections.has("favorites") && (
              <div className="py-0.5">
                {favoriteBranchList.map((branch) => (
                  <BranchItem
                    key={branch.name}
                    branch={branch}
                    depth={0}
                    displayName={branch.name}
                    isFavorite
                    onToggleFavorite={() => toggleFavoriteBranch(branch.name)}
                    onContextMenu={(e) => handleContextMenu(e, branch.name, branch.isHead)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* HEAD (Current Branch) section */}
        {headBranch && (
          <>
            <SectionHeader
              icon={<CheckIcon className="text-primary size-3.5" />}
              title="HEAD"
              count={1}
              expanded={expandedSections.has("head")}
              onToggle={() => toggleSection("head")}
            />
            {expandedSections.has("head") && (
              <div className="py-0.5">
                <BranchItem
                  branch={headBranch}
                  depth={0}
                  displayName={headBranch.name}
                  isFavorite={favoriteBranches.has(headBranch.name)}
                  onToggleFavorite={() => toggleFavoriteBranch(headBranch.name)}
                  onContextMenu={(e) => handleContextMenu(e, headBranch.name, true)}
                />
              </div>
            )}
          </>
        )}

        {/* Local branches */}
        <SectionHeader
          icon={<GitBranchIcon className="size-3.5" />}
          title="Local"
          count={branches.length}
          expanded={expandedSections.has("local")}
          onToggle={() => toggleSection("local")}
        />
        {expandedSections.has("local") && (
          <div className="py-0.5">
            {localGroups.map((group) => (
              <BranchGroupSection
                key={group.prefix || "__ungrouped"}
                group={group}
                expanded={expandedSections.has(`local:${group.prefix}`)}
                onToggle={() => toggleSection(`local:${group.prefix}`)}
                onContextMenu={handleContextMenu}
                onToggleFavorite={toggleFavoriteBranch}
                favoriteBranches={favoriteBranches}
                showPrefix={localGroups.length > 1 || group.prefix !== ""}
                depth={0}
              />
            ))}
          </div>
        )}

        {/* Remote branches by remote */}
        {Array.from(remoteGroupsByRemote.entries()).map(([remote, groups]) => (
          <div key={remote}>
            <SectionHeader
              icon={<GlobeIcon className="size-3.5" />}
              title={remote}
              count={groups.reduce((sum, g) => sum + g.branches.length, 0)}
              expanded={expandedSections.has(remote)}
              onToggle={() => toggleSection(remote)}
            />
            {expandedSections.has(remote) && (
              <div className="py-0.5">
                {groups.map((group) => (
                  <RemoteBranchGroupSection
                    key={group.prefix || "__ungrouped"}
                    group={group}
                    remote={remote}
                    expanded={expandedSections.has(`${remote}:${group.prefix}`)}
                    onToggle={() => toggleSection(`${remote}:${group.prefix}`)}
                    onContextMenu={handleContextMenu}
                    showPrefix={groups.length > 1 || group.prefix !== ""}
                    depth={0}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <BranchContextMenu
        open={contextMenu.open}
        position={contextMenu.position}
        branchName={contextMenu.branchName}
        isCurrentBranch={contextMenu.isCurrentBranch}
        onClose={closeContextMenu}
      />
    </div>
  );
}

function SectionHeader({
  icon,
  title,
  count,
  expanded,
  onToggle,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className="bg-muted/50 hover:bg-muted flex w-full items-center gap-1.5 px-2 py-1 text-xs font-medium transition-colors duration-100"
      onClick={onToggle}
    >
      <span className="flex size-3 shrink-0 items-center justify-center">
        {expanded ? (
          <ChevronDownIcon className="size-3" />
        ) : (
          <ChevronRightIcon className="size-3" />
        )}
      </span>
      {icon}
      <span className="text-foreground">{title}</span>
      <span className="text-muted-foreground ml-auto text-[10px]">{count}</span>
    </button>
  );
}

function BranchGroupSection({
  group,
  expanded,
  onToggle,
  onContextMenu,
  onToggleFavorite,
  favoriteBranches,
  showPrefix,
  depth,
}: {
  group: BranchGroup;
  expanded: boolean;
  onToggle: () => void;
  onContextMenu: (e: React.MouseEvent, branchName: string, isCurrentBranch: boolean) => void;
  onToggleFavorite: (name: string) => void;
  favoriteBranches: Set<string>;
  showPrefix: boolean;
  depth: number;
}) {
  const indentPx = INDENT_BASE + depth * INDENT_STEP;

  // If there's no prefix, show branches directly at current depth
  if (!showPrefix || group.prefix === "") {
    return (
      <>
        {group.branches.map((branch) => (
          <BranchItem
            key={branch.name}
            branch={branch}
            depth={depth}
            displayName={branch.name}
            isFavorite={favoriteBranches.has(branch.name)}
            onToggleFavorite={() => onToggleFavorite(branch.name)}
            onContextMenu={(e) => onContextMenu(e, branch.name, branch.isHead)}
          />
        ))}
      </>
    );
  }

  // Show collapsible folder for prefix groups
  return (
    <div>
      <button
        className="hover:bg-muted/50 flex w-full items-center gap-1.5 py-1 pr-3 text-xs"
        style={{ paddingLeft: indentPx }}
        onClick={onToggle}
      >
        <span className="flex size-3 shrink-0 items-center justify-center">
          {expanded ? (
            <ChevronDownIcon className="text-muted-foreground size-3" />
          ) : (
            <ChevronRightIcon className="text-muted-foreground size-3" />
          )}
        </span>
        <FolderIcon className="text-muted-foreground size-3 shrink-0" />
        <span className="text-muted-foreground">{group.prefix}/</span>
        <span className="text-muted-foreground ml-auto text-[10px]">{group.branches.length}</span>
      </button>
      {expanded &&
        group.branches.map((branch) => (
          <BranchItem
            key={branch.name}
            branch={branch}
            depth={depth + 1}
            displayName={branch.name.split("/").slice(1).join("/")}
            isFavorite={favoriteBranches.has(branch.name)}
            onToggleFavorite={() => onToggleFavorite(branch.name)}
            onContextMenu={(e) => onContextMenu(e, branch.name, branch.isHead)}
          />
        ))}
    </div>
  );
}

function RemoteBranchGroupSection({
  group,
  remote,
  expanded,
  onToggle,
  onContextMenu,
  showPrefix,
  depth,
}: {
  group: BranchGroup;
  remote: string;
  expanded: boolean;
  onToggle: () => void;
  onContextMenu: (e: React.MouseEvent, branchName: string, isCurrentBranch: boolean) => void;
  showPrefix: boolean;
  depth: number;
}) {
  const indentPx = INDENT_BASE + depth * INDENT_STEP;

  // If there's no prefix, show branches directly at current depth
  if (!showPrefix || group.prefix === "") {
    return (
      <>
        {group.branches.map((branch) => (
          <RemoteBranchItem
            key={branch.name}
            name={branch.name}
            displayName={branch.name.replace(`${remote}/`, "")}
            depth={depth}
            onContextMenu={(e) => onContextMenu(e, branch.name, false)}
          />
        ))}
      </>
    );
  }

  // Show collapsible folder for prefix groups
  return (
    <div>
      <button
        className="hover:bg-muted/50 flex w-full items-center gap-1.5 py-1 pr-2 text-xs transition-colors duration-100"
        style={{ paddingLeft: indentPx }}
        onClick={onToggle}
      >
        <span className="flex size-3 shrink-0 items-center justify-center">
          {expanded ? (
            <ChevronDownIcon className="text-muted-foreground size-3" />
          ) : (
            <ChevronRightIcon className="text-muted-foreground size-3" />
          )}
        </span>
        <FolderIcon className="text-muted-foreground size-3 shrink-0" />
        <span className="text-muted-foreground">{group.prefix}/</span>
        <span className="text-muted-foreground ml-auto text-[10px]">{group.branches.length}</span>
      </button>
      {expanded &&
        group.branches.map((branch) => {
          const fullName = branch.name.replace(`${remote}/`, "");
          const displayName = fullName.split("/").slice(1).join("/");
          return (
            <RemoteBranchItem
              key={branch.name}
              name={branch.name}
              displayName={displayName}
              depth={depth + 1}
              onContextMenu={(e) => onContextMenu(e, branch.name, false)}
            />
          );
        })}
    </div>
  );
}

function RemoteBranchItem({
  name,
  displayName,
  depth,
  onContextMenu,
}: {
  name: string;
  displayName: string;
  depth: number;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const indentPx = INDENT_BASE + depth * INDENT_STEP + CHEVRON_WIDTH;

  return (
    <div
      className="hover:bg-muted flex items-center gap-1 py-1 pr-2 text-xs transition-colors duration-100"
      style={{ paddingLeft: indentPx }}
      onContextMenu={onContextMenu}
    >
      {/* Spacer to align with local branches that have star button */}
      <span className="size-4 shrink-0" />
      <GitBranchIcon className="text-muted-foreground size-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={name}>
        {displayName}
      </span>
    </div>
  );
}

function BranchItem({
  branch,
  depth,
  displayName,
  isFavorite,
  onToggleFavorite,
  onContextMenu,
}: {
  branch: BranchInfo;
  depth: number;
  displayName: string;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const indentPx = INDENT_BASE + depth * INDENT_STEP + CHEVRON_WIDTH;

  return (
    <div
      className={cn(
        "group hover:bg-primary/50 flex items-center gap-1 py-1 pr-2 text-xs transition-colors duration-100",
        branch.isHead && "bg-primary",
      )}
      style={{ paddingLeft: indentPx }}
      onContextMenu={onContextMenu}
    >
      {/* Favorite star */}
      <button
        className={cn(
          "flex size-4 shrink-0 items-center justify-center transition-opacity",
          isFavorite ? "opacity-100" : "opacity-0 group-hover:opacity-50",
        )}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite?.();
        }}
        title={isFavorite ? "Remove from favorites" : "Add to favorites"}
      >
        <StarIcon
          className={cn(
            "size-3",
            isFavorite ? "fill-yellow-500 text-yellow-500" : "text-muted-foreground",
          )}
        />
      </button>

      {branch.isHead ? (
        <CheckIcon className="text-primary size-3 shrink-0" />
      ) : (
        <GitBranchIcon className="text-muted-foreground size-3 shrink-0" />
      )}
      <span className="min-w-0 truncate" title={branch.name}>
        {displayName}
      </span>

      {/* Ahead/behind badges */}
      {branch.upstream && (branch.ahead > 0 || branch.behind > 0) && (
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px]">
          {branch.ahead > 0 && (
            <span
              className="bg-diff-add-bg text-diff-add-text flex items-center gap-0.5 rounded px-1 py-0.5"
              title={`${branch.ahead} ahead`}
            >
              <ArrowUpIcon className="size-2.5" />
              {branch.ahead}
            </span>
          )}
          {branch.behind > 0 && (
            <span
              className="bg-diff-del-bg text-diff-del-text flex items-center gap-0.5 rounded px-1 py-0.5"
              title={`${branch.behind} behind`}
            >
              <ArrowDownIcon className="size-2.5" />
              {branch.behind}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
