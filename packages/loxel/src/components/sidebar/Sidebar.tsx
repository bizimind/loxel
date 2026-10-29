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
import { FileTypeIcon } from "@/lib/file-icons";
import { focusSidebarEntryForPath, handleSidebarEntryKeyDown } from "@/lib/focus-navigation";
import { focusAreaProps, SIDEBAR_ENTRY_ATTR, sidebarEntryProps } from "@/lib/focus-targets";
import { frontendLog } from "@/lib/frontend-logger";
import { abbreviateHomePath } from "@/lib/home-path";
import { cn } from "@/lib/utils";
import { clampSidebarWidth, SIDEBAR_DEFAULT_WIDTH, useProjectStore } from "@/store/projects";
import { useWorktreeStore } from "@/store/worktrees";

import { AddProjectWizard } from "../projects/AddProjectWizard";
import { ProjectIcon } from "../projects/ProjectIcon";
import { EnableNestingDialog } from "./EnableNestingDialog";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { RAIL_PADDING, railDepth, railWidth } from "./worktree-geometry";
import { WorktreeTree } from "./WorktreeTree";

// ── Project icon with folder badge ──────────────────────────────────────

/** ProjectIcon wrapped with a small folder badge in the bottom-right corner. */
function ProjectIconWithBadge({
  id,
  name,
  size,
  active,
}: {
  id: string;
  name: string;
  size: "xs" | "sm" | "md";
  active?: boolean;
}) {
  return (
    <div className="relative shrink-0">
      <ProjectIcon id={id} name={name} size={size} active={active} />
      <FileTypeIcon
        filename="folder"
        isFolder
        className="absolute -right-1 -bottom-1 size-3 drop-shadow-[0_0_1px_var(--card)]"
      />
    </div>
  );
}

/** Collapsed-rail tiles (32px) line up with the top-level worktree icons (24px). */
const RAIL_TILE_LEFT = RAIL_PADDING - 4;
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
              // A full-width line between projects
              className={cn(index > 0 && "border-border mt-1 border-t pt-1")}
              data-sidebar-project
            >
              {sidebarExpanded ? (
                <div
                  className={cn(
                    "hover:bg-primary/50 group focus-visible:ring-ring relative flex cursor-pointer items-center gap-2 px-2.5 py-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset",
                    isRootActive && "bg-primary",
                  )}
                  style={{ paddingLeft: "8px" }}
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

                  <ProjectIconWithBadge id={project.id} name={project.name} size="sm" />

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
                          className="text-muted-foreground truncate text-[10px]"
                          title={project.path}
                        >
                          {abbreviateHomePath(project.path, homeDir)}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex py-1.5" style={{ paddingLeft: `${RAIL_TILE_LEFT}px` }}>
                  <button
                    className={cn("cursor-pointer rounded-md", ENTRY_FOCUS_RING)}
                    onClick={() => handleProjectClick(project)}
                    {...sidebarEntryProps(project.path)}
                    onContextMenu={(e) => handleProjectContextMenu(e, project)}
                    onKeyDown={onProjectKeyDown}
                    title={`${project.name}\n${project.path}`}
                  >
                    <ProjectIconWithBadge
                      id={project.id}
                      name={project.name}
                      size="md"
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
        <div className={cn(projects.length > 0 && "border-border mt-1 border-t pt-1")}>
          {sidebarExpanded ? (
            <div
              className="text-muted-foreground hover:text-foreground hover:bg-primary/50 flex cursor-pointer items-center gap-2.5 px-2.5 py-2 transition-colors"
              style={{ paddingLeft: "13px" }}
              onClick={handleAddProject}
            >
              <div className="flex size-6 shrink-0 items-center justify-center">
                <FolderPlusIcon className="size-4" />
              </div>
              <span className="text-xs">Add project</span>
            </div>
          ) : (
            <div className="flex py-1.5" style={{ paddingLeft: `${RAIL_TILE_LEFT}px` }}>
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
