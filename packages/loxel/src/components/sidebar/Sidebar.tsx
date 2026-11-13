/**
 * Unified sidebar — shows all projects with their worktrees as collapsible groups.
 * Every project can expand to show linked worktrees; a non-bare project's
 * header remains the switch target for its root checkout.
 * Replaces the separate ProjectSidebar and WorktreeSidebar components.
 */
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderPlusIcon,
  ListTreeIcon,
  PencilIcon,
  TrashIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Project } from "@/api/project-model";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { getTreeActionForEvent } from "@/hooks/useTreeKeyboardNav";
import { focusSidebarEntryForPath, handleSidebarEntryKeyDown } from "@/lib/focus-navigation";
import { focusAreaProps, SIDEBAR_ENTRY_ATTR, sidebarEntryProps } from "@/lib/focus-targets";
import { frontendLog } from "@/lib/frontend-logger";
import { abbreviateHomePath } from "@/lib/home-path";
import { onLoxelEvent } from "@/lib/loxel-events";
import { cn } from "@/lib/utils";
import { clampSidebarWidth, SIDEBAR_DEFAULT_WIDTH, useProjectStore } from "@/store/projects";
import { useWorktreeStore } from "@/store/worktrees";

import { AddProjectWizard } from "../projects/AddProjectWizard";
import { ProjectIcon } from "../projects/ProjectIcon";
import { LoxelLogoTile } from "../ui/loxel-logo";
import { EnableNestingDialog } from "./EnableNestingDialog";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { ICON_PX, iconLeft, iconLeftExpanded, railDepth, railWidth } from "./worktree-geometry";
import { WorktreeTree } from "./WorktreeTree";

/** Expanded project rows: the row's left padding, before the fold chevron. */
const ROW_LEFT = 8;
/** The fold chevron's width (`size-3.5`). */
const CHEVRON_PX = 14;
/** Puts the expanded project icon in the column of the top-level worktree icons below it. */
const ICON_MARGIN_LEFT = iconLeftExpanded(0) - ROW_LEFT - CHEVRON_PX;
/** The rail's Home and Add project buttons (`size-8`), centered on the worktree icons' column. */
const RAIL_ADD_PX = 32;
const RAIL_ADD_LEFT = iconLeft(0) - (RAIL_ADD_PX - ICON_PX) / 2;
/** Keyboard cursor ring for the collapsed rail's icon buttons. */
const ENTRY_FOCUS_RING =
  "focus-visible:ring-ring focus-visible:ring-offset-card outline-none focus-visible:ring-2 focus-visible:ring-offset-2";

// ── Main Sidebar ────────────────────────────────────────────────────────

export function Sidebar() {
  const projects = useProjectStore((s) => s.projects);
  const homeDir = useProjectStore((s) => s.homeDir);
  const sidebarExpanded = useProjectStore((s) => s.sidebarExpanded);
  const sidebarWidth = useProjectStore((s) => s.sidebarWidth);
  const setSidebarWidth = useProjectStore((s) => s.setSidebarWidth);
  const expandedProjectIds = useProjectStore((s) => s.expandedProjectIds);
  const toggleProjectExpanded = useProjectStore((s) => s.toggleProjectExpanded);
  const addProject = useProjectStore((s) => s.addProject);
  const removeProject = useProjectStore((s) => s.removeProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const updateProject = useProjectStore((s) => s.updateProject);

  const activeWorktreePath = useWorktreeStore((s) => s.activeWorktreePath);
  const switchWorktree = useWorktreeStore((s) => s.switchWorktree);
  const showHome = useWorktreeStore((s) => s.showHome);

  // Auto-expand newly loaded projects once so worktrees and the create action are visible.
  // The "once" marker lives in the persisted store, not a ref: the sidebar remounts when the
  // first worktree is selected, and a ref would forget which collapses were deliberate.
  useEffect(() => {
    const {
      expandedProjectIds: expanded,
      autoExpandedProjectIds: autoExpanded,
      toggleProjectExpanded: toggle,
      markAutoExpanded,
    } = useProjectStore.getState();
    const expandedSet = new Set(expanded);
    const autoExpandedSet = new Set(autoExpanded);
    for (const p of projects) {
      if (!expandedSet.has(p.id) && !autoExpandedSet.has(p.id)) toggle(p.id);
    }
    markAutoExpanded(projects.map((p) => p.id));
  }, [projects]);

  // Live width while dragging the resize handle; committed to the store on release.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const expandedWidth = clampSidebarWidth(dragWidth ?? sidebarWidth);

  const handleResizeEnd = useCallback(
    (width: number) => {
      setDragWidth(null);
      setSidebarWidth(width);
    },
    [setSidebarWidth],
  );

  const handleResizeReset = useCallback(
    () => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH),
    [setSidebarWidth],
  );

  const [wizardOpen, setWizardOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [removingProject, setRemovingProject] = useState<Project | null>(null);
  const [deletingProject, setDeletingProject] = useState<Project | null>(null);

  const [contextMenu, setContextMenu] = useState<{
    open: boolean;
    position: { x: number; y: number };
    project: Project;
  } | null>(null);

  const expandedSet = useMemo(() => new Set(expandedProjectIds), [expandedProjectIds]);
  // The rail is as wide as the deepest nesting it shows, across the expanded projects.
  const collapsedWidth = useWorktreeStore((s) =>
    railWidth(
      Math.max(
        0,
        ...projects
          .filter((p) => expandedSet.has(p.id))
          .map((p) => {
            const ps = s.byProject[p.path];
            return ps ? railDepth(ps, s.openArchives.includes(p.path)) : 0;
          }),
      ),
    ),
  );
  // Explicitly false: unknown until the project's worktrees have loaded.
  const menuProjectNestingOff = useWorktreeStore(
    (s) =>
      contextMenu !== null && s.byProject[contextMenu.project.path]?.worktreeMetadata === false,
  );
  const [nestingProjectPath, setNestingProjectPath] = useState<string | null>(null);

  // Home's quickstart opens the dialog here, so a panel replacing the quickstart can't close it.
  useEffect(() => onLoxelEvent("loxel-open-add-project-wizard", () => setWizardOpen(true)), []);

  const handleAddProject = useCallback(async () => {
    if (window.electronAPI?.openFolderDialog) {
      const path = await window.electronAPI.openFolderDialog();
      if (path) await addProject(path);
    } else {
      setWizardOpen(true);
    }
  }, [addProject]);

  const handleProjectContextMenu = useCallback((e: React.MouseEvent, project: Project) => {
    e.preventDefault();
    setContextMenu({ open: true, position: { x: e.clientX, y: e.clientY }, project });
  }, []);

  const handleRenameStart = useCallback((project: Project) => {
    setRenamingId(project.id);
    setRenameValue(project.name);
    setContextMenu(null);
  }, []);

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  const handleRenameSubmit = useCallback(async () => {
    if (!renamingId || !renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    try {
      await updateProject(renamingId, { name: renameValue.trim() });
    } catch (err) {
      frontendLog
        .child("ui")
        .error("Failed to rename project", { error: err instanceof Error ? err : undefined });
    }
    setRenamingId(null);
  }, [renamingId, renameValue, updateProject]);

  const handleRemoveRequest = useCallback((project: Project) => {
    setContextMenu(null);
    setRemovingProject(project);
  }, []);

  const handleRemoveConfirm = useCallback(() => {
    if (removingProject) {
      removeProject(removingProject.id);
      setRemovingProject(null);
    }
  }, [removingProject, removeProject]);

  const handleDeleteRequest = useCallback((project: Project) => {
    setContextMenu(null);
    setDeletingProject(project);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (deletingProject) {
      try {
        await deleteProject(deletingProject.id);
        setDeletingProject(null);
      } catch {
        // Keep dialog open on failure — store will show the error
      }
    }
  }, [deletingProject, deleteProject]);

  /** The tree's expand and collapse actions on a project row: fold or unfold its worktrees, or step into the first one. */
  const handleProjectKeyDown = useCallback(
    (e: React.KeyboardEvent, project: Project, isExpanded: boolean) => {
      const action = getTreeActionForEvent(e);
      if (action !== "tree.expandOrFocusChild" && action !== "tree.collapseOrFocusParent") return;
      e.preventDefault();
      e.stopPropagation();
      if (action === "tree.collapseOrFocusParent") {
        if (isExpanded) toggleProjectExpanded(project.id);
        return;
      }
      if (!isExpanded) {
        toggleProjectExpanded(project.id);
        return;
      }
      // The first worktree entry after this project's own entry, inside the project's block.
      const block = e.currentTarget.closest("[data-sidebar-project]");
      const first = block?.querySelectorAll(`[${SIDEBAR_ENTRY_ATTR}]`)[1];
      const path = first?.getAttribute(SIDEBAR_ENTRY_ATTR);
      if (path) focusSidebarEntryForPath(path);
    },
    [toggleProjectExpanded],
  );

  /** Click a project row: regular repos switch to their root; bare repos toggle expansion. */
  const handleProjectClick = useCallback(
    (project: Project) => {
      const projectIsBare = project.isBare ?? false;

      if (projectIsBare) {
        // For bare repos: just toggle expand/collapse — user picks a worktree explicitly
        toggleProjectExpanded(project.id);
      } else if (activeWorktreePath !== project.path) {
        // Non-bare: switch to project path as the worktree
        switchWorktree(project.path);
      }
    },
    [activeWorktreePath, switchWorktree, toggleProjectExpanded],
  );

  const isHome = activeWorktreePath === null;
  // Muted until Home is shown, like an entry that isn't the one in use.
  const homeTileClass = cn(
    "size-6 transition-colors",
    isHome ? "text-foreground" : "text-muted-foreground hover:text-foreground",
  );

  return (
    <div
      className={cn(
        "bg-card border-border relative flex flex-col border-r",
        // Animate expand/collapse, but track the pointer directly while resizing
        dragWidth === null && "transition-[width] duration-150 ease-out",
      )}
      style={{ width: sidebarExpanded ? expandedWidth : collapsedWidth }}
      {...focusAreaProps("worktrees")}
    >
      {sidebarExpanded && (
        <SidebarResizeHandle
          width={expandedWidth}
          onResize={setDragWidth}
          onResizeEnd={handleResizeEnd}
          onReset={handleResizeReset}
        />
      )}
      {/* Project + worktree list */}
      <div
        className="flex-1 overflow-x-hidden overflow-y-auto pt-1"
        onKeyDown={handleSidebarEntryKeyDown}
      >
        {/* Home, the browser panels shown with no worktree, set off from the projects like they are */}
        <div className="mb-2">
          {sidebarExpanded ? (
            // Laid out like a project row, so its logo sits in the column of the project icons.
            <button
              type="button"
              className={cn(
                "hover:bg-primary/50 focus-visible:ring-ring flex w-full cursor-pointer items-center py-1.5 text-left transition-colors outline-none not-dark:mx-1 not-dark:w-[calc(100%-0.5rem)] not-dark:rounded-md not-dark:pl-1! focus-visible:ring-2 focus-visible:ring-inset",
                isHome && "bg-primary",
              )}
              style={{ paddingLeft: `${ROW_LEFT}px` }}
              onClick={showHome}
              aria-current={isHome ? "page" : undefined}
            >
              {/* Where a project row has its fold chevron */}
              <span className="shrink-0" style={{ width: `${CHEVRON_PX}px` }} />
              <span className="mr-2.5 shrink-0" style={{ marginLeft: `${ICON_MARGIN_LEFT}px` }}>
                <LoxelLogoTile className={homeTileClass} />
              </span>
              {/* Two lines like a project row: its name, and where it is */}
              <span className="min-w-0 flex-1 overflow-hidden">
                <span className="text-foreground block truncate text-xs font-medium">Home</span>
                <span
                  className={cn(
                    "text-muted-foreground block truncate text-[10px]",
                    isHome && "not-dark:text-foreground/70",
                  )}
                >
                  Outside any project
                </span>
              </span>
            </button>
          ) : (
            // The app's logo in the column of the worktree icons, ringed like the active project
            // icon while Home is shown.
            <div className="flex py-1.5" style={{ paddingLeft: `${iconLeft(0)}px` }}>
              <button
                type="button"
                className={cn("cursor-pointer rounded-[30%]", ENTRY_FOCUS_RING)}
                onClick={showHome}
                title="Home"
                aria-current={isHome ? "page" : undefined}
              >
                <LoxelLogoTile
                  className={cn(
                    homeTileClass,
                    // The active project's ring, with a gap in the card color in both themes: its
                    // white inner band would merge with the white tile.
                    isHome &&
                      "shadow-[0_0_0_2px_var(--card),0_0_0_3.5px_color-mix(in_srgb,var(--ring)_75%,transparent)] dark:shadow-[0_0_0_2px_var(--card),0_0_0_4px_var(--primary)]",
                  )}
                />
              </button>
            </div>
          )}
        </div>

        {projects.map((project, index) => {
          const isRootActive = activeWorktreePath === project.path;
          const isExpanded = expandedSet.has(project.id);
          const isRenaming = project.id === renamingId;
          const onProjectKeyDown = (e: React.KeyboardEvent) =>
            handleProjectKeyDown(e, project, isExpanded);

          // The worktree tree stays mounted across both sidebar states, so expanding animates it.
          return (
            <div
              key={project.id}
              // Space, not a line, between projects: lines on the rail are the worktree tree's brackets
              className={cn(index > 0 && "mt-2")}
              data-sidebar-project
            >
              {sidebarExpanded ? (
                <div
                  className={cn(
                    // Light insets the row with rounded corners like the worktree rows' highlight, taking
                    // the inset out of its left padding (ROW_LEFT - 4px) so the icons keep their column
                    "hover:bg-primary/50 group focus-visible:ring-ring relative flex cursor-pointer items-center px-2.5 py-1.5 transition-colors outline-none not-dark:mx-1 not-dark:rounded-md not-dark:pl-1! focus-visible:ring-2 focus-visible:ring-inset",
                    isRootActive && "bg-primary",
                  )}
                  style={{ paddingLeft: `${ROW_LEFT}px` }}
                  tabIndex={-1}
                  {...sidebarEntryProps(project.path)}
                  onClick={() => !isRenaming && handleProjectClick(project)}
                  onContextMenu={(e) => handleProjectContextMenu(e, project)}
                  onKeyDown={onProjectKeyDown}
                >
                  <button
                    className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleProjectExpanded(project.id);
                    }}
                    title={isExpanded ? "Collapse worktrees" : "Expand worktrees"}
                  >
                    {isExpanded ? (
                      <ChevronDownIcon className="size-3.5" />
                    ) : (
                      <ChevronRightIcon className="size-3.5" />
                    )}
                  </button>

                  <div className="mr-2.5 shrink-0" style={{ marginLeft: `${ICON_MARGIN_LEFT}px` }}>
                    <ProjectIcon id={project.id} name={project.name} size="sm" />
                  </div>

                  <div className="min-w-0 flex-1 overflow-hidden">
                    {isRenaming ? (
                      <input
                        ref={renameInputRef}
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={handleRenameSubmit}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") e.currentTarget.blur();
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="bg-background border-border text-foreground w-full rounded border px-1 py-0.5 text-xs outline-none"
                      />
                    ) : (
                      <>
                        <div className="text-foreground truncate text-xs font-medium">
                          {project.name}
                        </div>
                        <div
                          className={cn(
                            "text-muted-foreground truncate text-[10px]",
                            isRootActive && "not-dark:text-foreground/70",
                          )}
                          title={project.path}
                        >
                          {abbreviateHomePath(project.path, homeDir)}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex py-1.5" style={{ paddingLeft: `${iconLeft(0)}px` }}>
                  <button
                    // Rounded like the keyboard ring on a worktree icon
                    className={cn("cursor-pointer rounded-[30%]", ENTRY_FOCUS_RING)}
                    onClick={() => handleProjectClick(project)}
                    {...sidebarEntryProps(project.path)}
                    onContextMenu={(e) => handleProjectContextMenu(e, project)}
                    onKeyDown={onProjectKeyDown}
                    title={`${project.name}\n${project.path}`}
                  >
                    <ProjectIcon
                      id={project.id}
                      name={project.name}
                      size="sm"
                      active={isRootActive}
                    />
                  </button>
                </div>
              )}
              {isExpanded && <WorktreeTree project={project} expanded={sidebarExpanded} />}
            </div>
          );
        })}

        {/* Add project button, set off from the projects like they are from each other */}
        <div className={cn(projects.length > 0 && "mt-2")}>
          {sidebarExpanded ? (
            <div
              className="text-muted-foreground hover:text-foreground hover:bg-primary/50 flex cursor-pointer items-center gap-2.5 px-2.5 py-2 transition-colors not-dark:mx-1 not-dark:rounded-md not-dark:px-1.5"
              style={{ paddingLeft: "13px" }}
              onClick={handleAddProject}
            >
              <div className="flex size-6 shrink-0 items-center justify-center">
                <FolderPlusIcon className="size-4" />
              </div>
              <span className="text-xs">Add project</span>
            </div>
          ) : (
            <div className="flex py-1.5" style={{ paddingLeft: `${RAIL_ADD_LEFT}px` }}>
              <button
                className="text-muted-foreground hover:text-foreground flex size-8 cursor-pointer items-center justify-center rounded-md transition-colors"
                onClick={handleAddProject}
                title="Add project"
              >
                <FolderPlusIcon className="size-5" />
              </button>
            </div>
          )}
        </div>
      </div>

      <AddProjectWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />

      {/* Project context menu */}
      {contextMenu && (
        <ContextMenu
          open={contextMenu.open}
          onOpenChange={(open) => !open && setContextMenu(null)}
          position={contextMenu.position}
        >
          <ContextMenuItem onClick={() => handleRenameStart(contextMenu.project)}>
            <PencilIcon className="size-3.5" />
            Rename
          </ContextMenuItem>
          {menuProjectNestingOff && (
            <ContextMenuItem
              onClick={() => {
                setContextMenu(null);
                setNestingProjectPath(contextMenu.project.path);
              }}
            >
              <ListTreeIcon className="size-3.5" />
              Enable worktree nesting…
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => handleRemoveRequest(contextMenu.project)}>
            <XIcon className="size-3.5" />
            Remove from list
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onClick={() => handleDeleteRequest(contextMenu.project)}
          >
            <TrashIcon className="size-3.5" />
            Delete from disk
          </ContextMenuItem>
        </ContextMenu>
      )}

      {nestingProjectPath && (
        <EnableNestingDialog
          projectPath={nestingProjectPath}
          onClose={() => setNestingProjectPath(null)}
        />
      )}

      {/* Remove project confirmation dialog */}
      <ConfirmDialog
        open={removingProject !== null}
        title="Remove project"
        description={`Remove "${removingProject?.name}" from the project list? This does not delete any files.`}
        confirmLabel="Remove"
        destructive
        onConfirm={handleRemoveConfirm}
        onCancel={() => setRemovingProject(null)}
      />

      {/* Delete project confirmation dialog */}
      <ConfirmDialog
        open={deletingProject !== null}
        title="Delete project"
        description={
          <>
            Permanently delete <strong>{deletingProject?.name}</strong> and all its files from disk?
            <br />
            <span className="text-destructive mt-1 inline-block text-[11px] font-medium">
              This cannot be undone.
            </span>
          </>
        }
        confirmLabel="Delete permanently"
        destructive
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeletingProject(null)}
      />
    </div>
  );
}
