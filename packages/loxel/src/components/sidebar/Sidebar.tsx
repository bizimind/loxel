/**
 * Unified sidebar — shows all projects with their worktrees as collapsible groups.
 * Bare repos expand to show worktrees; non-bare repos are single clickable rows.
 * Replaces the separate ProjectSidebar and WorktreeSidebar components.
 */
import type { DragEndEvent, DragStartEvent, UniqueIdentifier } from "@dnd-kit/core";

import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronsLeftIcon,
  ChevronsRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  FolderPlusIcon,
  GitBranchPlusIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { WorktreeEntry } from "@/api/git-models";
import type { Project } from "@/api/project-model";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { DialogShell } from "@/components/ui/dialog-shell";
import { NotificationDot } from "@/components/ui/notification-dot";
import { dayjs } from "@/lib/dayjs";
import { FileTypeIcon } from "@/lib/file-icons";
import { frontendLog } from "@/lib/frontend-logger";
import { cn } from "@/lib/utils";
import { hasWorktreeNotification, usePanelNotificationStore } from "@/store/panel-notifications";
import { deriveProject, useProjectStore } from "@/store/projects";
import { getOrderedWorktrees, useWorktreeStore } from "@/store/worktrees";

import { AddProjectWizard } from "../projects/AddProjectWizard";
import { ProjectIcon } from "../projects/ProjectIcon";
import { WorktreeIcon } from "../worktrees/WorktreeIcon";

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

const COLLAPSED_WIDTH = 48;
const EXPANDED_WIDTH = 240;
const EMPTY_STRINGS: string[] = [];
const EMPTY_WORKTREES: WorktreeEntry[] = [];

// ── Shared worktree removal hook ────────────────────────────────────────

function useWorktreeRemoval(projectPath: string) {
  const ps = useWorktreeStore((s) => s.byProject[projectPath]);
  const hasWtConfig = ps?.hasWtConfig ?? false;
  const requestRemoveWorktree = useWorktreeStore((s) => s.requestRemoveWorktree);
  const confirmRemoveWorktree = useWorktreeStore((s) => s.confirmRemoveWorktree);
  const dismissPendingPlan = useWorktreeStore((s) => s.dismissPendingPlan);
  const pendingRemovePlan = useWorktreeStore((s) =>
    s.pendingRemovePlan?.projectPath === projectPath ? s.pendingRemovePlan : null,
  );

  const [contextMenu, setContextMenu] = useState<{
    open: boolean;
    position: { x: number; y: number };
    worktree: WorktreeEntry;
  } | null>(null);
  const [removingWorktree, setRemovingWorktree] = useState<WorktreeEntry | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, wt: WorktreeEntry) => {
    e.preventDefault();
    setContextMenu({ open: true, position: { x: e.clientX, y: e.clientY }, worktree: wt });
  }, []);

  const handleRemoveRequest = useCallback(
    async (wt: WorktreeEntry) => {
      setContextMenu(null);
      setRemoveError(null);

      if (hasWtConfig) {
        try {
          await requestRemoveWorktree(projectPath, wt);
        } catch (err) {
          setRemoveError(err instanceof Error ? err.message : "Failed to inspect worktree");
        }
      } else {
        setRemovingWorktree(wt);
      }
    },
    [hasWtConfig, requestRemoveWorktree, projectPath],
  );

  const handleSimpleRemoveConfirm = useCallback(async () => {
    if (!removingWorktree) return;
    setRemovingWorktree(null);
    try {
      await requestRemoveWorktree(projectPath, removingWorktree);
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "Failed to remove worktree");
    }
  }, [removingWorktree, requestRemoveWorktree, projectPath]);

  const handlePlanRemoveConfirm = useCallback(
    async (deleteBranch: boolean) => {
      setRemoveError(null);
      try {
        const hasDirtyState = pendingRemovePlan?.status !== null;
        await confirmRemoveWorktree({ deleteBranch, force: hasDirtyState });
      } catch (err) {
        setRemoveError(err instanceof Error ? err.message : "Failed to remove worktree");
      }
    },
    [confirmRemoveWorktree, pendingRemovePlan],
  );

  return {
    contextMenu,
    setContextMenu,
    removingWorktree,
    setRemovingWorktree,
    removeError,
    setRemoveError,
    pendingRemovePlan,
    dismissPendingPlan,
    handleContextMenu,
    handleRemoveRequest,
    handleSimpleRemoveConfirm,
    handlePlanRemoveConfirm,
  };
}

/** Renders context menu + confirmation dialogs for worktree removal. */
function WorktreeRemoveDialogs({ removal }: { removal: ReturnType<typeof useWorktreeRemoval> }) {
  return (
    <>
      {/* Worktree context menu */}
      {removal.contextMenu && (
        <ContextMenu
          open={removal.contextMenu.open}
          onOpenChange={(open) => !open && removal.setContextMenu(null)}
          position={removal.contextMenu.position}
        >
          <ContextMenuItem
            variant="destructive"
            onClick={() => removal.handleRemoveRequest(removal.contextMenu!.worktree)}
          >
            <TrashIcon className="size-3.5" />
            Remove worktree
          </ContextMenuItem>
        </ContextMenu>
      )}

      {/* Simple remove confirmation */}
      <ConfirmDialog
        open={removal.removingWorktree !== null}
        title="Remove worktree"
        description={`Remove worktree "${removal.removingWorktree ? worktreeName(removal.removingWorktree) : ""}"? This will delete the worktree directory.`}
        confirmLabel="Remove"
        destructive
        onConfirm={removal.handleSimpleRemoveConfirm}
        onCancel={() => removal.setRemovingWorktree(null)}
      />

      {/* Enhanced remove dialog (wt library plan) */}
      {removal.pendingRemovePlan && (
        <RemoveWorktreeDialog
          plan={removal.pendingRemovePlan}
          error={removal.removeError}
          onConfirm={removal.handlePlanRemoveConfirm}
          onCancel={() => {
            removal.dismissPendingPlan();
            removal.setRemoveError(null);
          }}
        />
      )}

      {/* Global remove error toast */}
      {removal.removeError && !removal.pendingRemovePlan && (
        <div className="text-destructive absolute right-2 bottom-2 left-2 text-[10px]">
          {removal.removeError}
        </div>
      )}
    </>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function worktreeName(wt: WorktreeEntry): string {
  return wt.wtName ?? wt.branch ?? wt.path.split("/").pop() ?? "worktree";
}

function worktreeSubtitle(wt: WorktreeEntry): string {
  if (wt.createdAt) return dayjs(wt.createdAt).fromNow();
  return wt.path;
}

// ── Main Sidebar ────────────────────────────────────────────────────────

export function Sidebar() {
  const projects = useProjectStore((s) => s.projects);
  const sidebarExpanded = useProjectStore((s) => s.sidebarExpanded);
  const expandedProjectIds = useProjectStore((s) => s.expandedProjectIds);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);
  const toggleProjectExpanded = useProjectStore((s) => s.toggleProjectExpanded);
  const addProject = useProjectStore((s) => s.addProject);
  const removeProject = useProjectStore((s) => s.removeProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const updateProject = useProjectStore((s) => s.updateProject);

  const activeWorktreePath = useWorktreeStore((s) => s.activeWorktreePath);
  const activeProject = useProjectStore((s) => deriveProject(activeWorktreePath, s.projects));
  const switchWorktree = useWorktreeStore((s) => s.switchWorktree);

  // Auto-expand bare projects that aren't already in the expanded set
  useEffect(() => {
    const { expandedProjectIds: expanded, toggleProjectExpanded: toggle } =
      useProjectStore.getState();
    const expandedSet = new Set(expanded);
    const toExpand = projects.filter((p) => (p.isBare ?? false) && !expandedSet.has(p.id));
    for (const p of toExpand) {
      toggle(p.id);
    }
  }, [projects]);

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

  /** Click a project row: for non-bare repos switch to it; for bare repos toggle expand. */
  const handleProjectClick = useCallback(
    (project: Project) => {
      const isActive = project.id === activeProject?.id;
      const projectIsBare = project.isBare ?? false;

      if (projectIsBare) {
        // For bare repos: just toggle expand/collapse — user picks a worktree explicitly
        toggleProjectExpanded(project.id);
      } else if (!isActive) {
        // Non-bare: switch to project path as the worktree
        switchWorktree(project.path);
      }
    },
    [activeProject, switchWorktree, toggleProjectExpanded],
  );

  return (
    <div
      className="bg-card border-border flex flex-col border-r transition-[width] duration-150 ease-out"
      style={{ width: sidebarExpanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH }}
    >
      {/* Toggle button */}
      <button
        onClick={toggleSidebar}
        className="text-muted-foreground hover:text-foreground flex h-8 shrink-0 cursor-pointer items-center justify-center transition-colors"
        title={sidebarExpanded ? "Collapse sidebar" : "Expand sidebar"}
      >
        {sidebarExpanded ? (
          <ChevronsLeftIcon className="size-3.5" />
        ) : (
          <ChevronsRightIcon className="size-3.5" />
        )}
      </button>

      {/* Project + worktree list */}
      <div className="flex-1 overflow-x-hidden overflow-y-auto">
        {projects.map((project) => {
          const isActive = project.id === activeProject?.id;
          const projectIsBare = project.isBare ?? false;
          const isExpanded = expandedSet.has(project.id);
          const isRenaming = project.id === renamingId;

          if (sidebarExpanded) {
            return (
              <div key={project.id}>
                {/* Project header row */}
                <div
                  className={cn(
                    "hover:bg-primary/50 group relative flex cursor-pointer items-center gap-2 px-2.5 py-1.5 transition-colors",
                    isActive && !projectIsBare && "bg-primary",
                  )}
                  style={{ paddingLeft: "8px" }}
                  onClick={() => !isRenaming && handleProjectClick(project)}
                  onContextMenu={(e) => handleProjectContextMenu(e, project)}
                >
                  {/* Expand/collapse chevron for bare repos, folder icon for non-bare */}
                  {projectIsBare ? (
                    <button
                      className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleProjectExpanded(project.id);
                      }}
                    >
                      {isExpanded ? (
                        <ChevronDownIcon className="size-3.5" />
                      ) : (
                        <ChevronRightIcon className="size-3.5" />
                      )}
                    </button>
                  ) : (
                    <FileTypeIcon filename="folder" isFolder className="size-3.5 shrink-0" />
                  )}

                  <ProjectIconWithBadge id={project.id} name={project.name} size="sm" />

                  <div className="min-w-0 flex-1 overflow-hidden">
                    {isRenaming ? (
                      <input
                        ref={renameInputRef}
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={handleRenameSubmit}
                        onKeyDown={(e) => {
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
                        <div className="text-muted-foreground truncate text-[10px]">
                          {project.path}
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* Worktree list for expanded bare repos */}
                {projectIsBare && isExpanded && <WorktreeList project={project} />}
              </div>
            );
          }

          // Collapsed mode — show project icon, with worktree icons underneath if expanded
          return (
            <div key={project.id}>
              <div className="flex justify-center py-1.5" style={{ paddingLeft: "3px" }}>
                <button
                  className="cursor-pointer"
                  onClick={() => handleProjectClick(project)}
                  onContextMenu={(e) => handleProjectContextMenu(e, project)}
                  title={`${project.name}\n${project.path}`}
                >
                  <ProjectIconWithBadge
                    id={project.id}
                    name={project.name}
                    size="md"
                    active={isActive && !projectIsBare}
                  />
                </button>
              </div>
              {projectIsBare && isExpanded && (
                <CollapsedWorktreeList project={project} activeWorktreePath={activeWorktreePath} />
              )}
            </div>
          );
        })}

        {/* Add project button */}
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
          <div className="flex justify-center py-1.5" style={{ paddingLeft: "3px" }}>
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

// ── Collapsed Worktree List ──────────────────────────────────────────────

function CollapsedWorktreeList({
  project,
  activeWorktreePath,
}: {
  project: Project;
  activeWorktreePath: string | null;
}) {
  const ps = useWorktreeStore((s) => s.byProject[project.path]);
  const worktrees = ps?.worktrees ?? EMPTY_WORKTREES;
  const customOrder = ps?.customOrder;
  const hiddenPaths = ps?.hiddenPaths ?? EMPTY_STRINGS;
  const switchWorktree = useWorktreeStore((s) => s.switchWorktree);
  const setCustomOrder = useWorktreeStore((s) => s.setCustomOrder);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);

  const removal = useWorktreeRemoval(project.path);

  const orderedWorktrees = useMemo(
    () => getOrderedWorktrees(worktrees, customOrder),
    [worktrees, customOrder],
  );
  const hiddenSet = useMemo(() => new Set(hiddenPaths), [hiddenPaths]);
  const visibleWorktrees = useMemo(
    () => orderedWorktrees.filter((wt) => !hiddenSet.has(wt.path)),
    [orderedWorktrees, hiddenSet],
  );
  const displayedIds = useMemo(() => visibleWorktrees.map((wt) => wt.path), [visibleWorktrees]);

  const [activeDragId, setActiveDragId] = useState<UniqueIdentifier | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = visibleWorktrees.findIndex((wt) => wt.path === active.id);
      const newIndex = visibleWorktrees.findIndex((wt) => wt.path === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const reordered = arrayMove(visibleWorktrees, oldIndex, newIndex);
      setCustomOrder(
        project.path,
        reordered.map((wt) => wt.path),
      );
    },
    [visibleWorktrees, setCustomOrder, project.path],
  );

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragStart={(e) => setActiveDragId(e.active.id)}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveDragId(null)}
      >
        <SortableContext items={displayedIds} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col items-center pb-0.5" style={{ paddingLeft: "3px" }}>
            {visibleWorktrees.map((wt) => {
              const name = worktreeName(wt);
              const wtIsActive = wt.path === activeWorktreePath;
              return (
                <SortableCollapsedIcon
                  key={wt.path}
                  id={wt.path}
                  name={name}
                  isActive={wtIsActive}
                  isPending={wt.pending ?? false}
                  onClick={() => !wt.pending && switchWorktree(wt.path)}
                  onContextMenu={(e) => !wt.pending && removal.handleContextMenu(e, wt)}
                />
              );
            })}
            {/* Add worktree button */}
            <div className="flex justify-center py-0.5">
              <button
                className="text-muted-foreground hover:text-foreground flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors"
                onClick={() => {
                  toggleSidebar();
                }}
                title="Add worktree"
              >
                <GitBranchPlusIcon className="size-4" />
              </button>
            </div>
          </div>
        </SortableContext>
        <DragOverlay dropAnimation={{ duration: 200, easing: "ease" }}>
          {activeDragId ? (
            <WorktreeIcon
              name={
                worktreeName(visibleWorktrees.find((wt) => wt.path === activeDragId)!) ??
                String(activeDragId)
              }
              size="md"
              active={false}
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      <WorktreeRemoveDialogs removal={removal} />
    </>
  );
}

/** Sortable wrapper for CollapsedWorktreeIcon. */
function SortableCollapsedIcon({
  id,
  name,
  isActive,
  isPending,
  onClick,
  onContextMenu,
}: {
  id: string;
  name: string;
  isActive: boolean;
  isPending: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <CollapsedWorktreeIcon
        id={id}
        name={name}
        isActive={isActive}
        isPending={isPending}
        onClick={onClick}
        onContextMenu={onContextMenu}
      />
    </div>
  );
}

function CollapsedWorktreeIcon({
  id,
  name,
  isActive,
  isPending,
  onClick,
  onContextMenu,
}: {
  id: string;
  name: string;
  isActive: boolean;
  isPending: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [labelPos, setLabelPos] = useState({ top: 0, left: 0 });

  const handleMouseEnter = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setLabelPos({ top: rect.top + rect.height / 2, left: rect.right + 8 });
    setHovered(true);
  }, []);

  const hasNotification = usePanelNotificationStore((s) => hasWorktreeNotification(s, id));

  return (
    <>
      <div className="flex justify-center py-1">
        <button
          className={cn("relative cursor-pointer", isPending && "opacity-50")}
          onClick={onClick}
          onContextMenu={onContextMenu}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={() => setHovered(false)}
        >
          <WorktreeIcon name={name} size="md" active={isActive} />
          {hasNotification && !isActive && <NotificationDot />}
        </button>
      </div>
      {hovered &&
        createPortal(
          <div
            className="animate-in fade-in slide-in-from-left-1 pointer-events-none fixed z-[9999] -translate-y-1/2 duration-150"
            style={{ top: labelPos.top, left: labelPos.left }}
          >
            <div className="bg-popover border-border text-foreground rounded-md border px-2.5 py-1 text-xs font-medium whitespace-nowrap shadow-lg">
              {name}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

// ── Worktree List (for expanded bare repo projects) ─────────────────────

function WorktreeList({ project }: { project: Project }) {
  const ps = useWorktreeStore((s) => s.byProject[project.path]);
  const worktrees = ps?.worktrees ?? EMPTY_WORKTREES;
  const customOrder = ps?.customOrder;
  const hiddenPaths = ps?.hiddenPaths ?? EMPTY_STRINGS;
  const activeWorktreePath = useWorktreeStore((s) => s.activeWorktreePath);
  const switchWorktree = useWorktreeStore((s) => s.switchWorktree);
  const createWorktree = useWorktreeStore((s) => s.createWorktree);
  const confirmCreateWorktree = useWorktreeStore((s) => s.confirmCreateWorktree);
  const dismissPendingPlan = useWorktreeStore((s) => s.dismissPendingPlan);
  const pendingAddPlan = useWorktreeStore((s) =>
    s.pendingAddPlan?.projectPath === project.path ? s.pendingAddPlan : null,
  );
  const setCustomOrder = useWorktreeStore((s) => s.setCustomOrder);
  const toggleVisibility = useWorktreeStore((s) => s.toggleVisibility);
  const createWorktreeRequested = useWorktreeStore((s) => s.createWorktreeRequested);
  const clearCreateWorktreeRequest = useWorktreeStore((s) => s.clearCreateWorktreeRequest);

  const removal = useWorktreeRemoval(project.path);

  const orderedWorktrees = useMemo(
    () => getOrderedWorktrees(worktrees, customOrder),
    [worktrees, customOrder],
  );
  const hiddenSet = useMemo(() => new Set(hiddenPaths), [hiddenPaths]);

  // Always show all worktrees in expanded sidebar
  const displayedWorktrees = orderedWorktrees;
  const displayedIds = useMemo(() => displayedWorktrees.map((wt) => wt.path), [displayedWorktrees]);

  const [addingWorktree, setAddingWorktree] = useState(false);
  const [addName, setAddName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  // Respond to keybinding-triggered create request
  useEffect(() => {
    if (!createWorktreeRequested) return;
    const activeProject = deriveProject(activeWorktreePath, useProjectStore.getState().projects);
    if (activeProject?.path !== project.path) return;
    clearCreateWorktreeRequest();
    setAddingWorktree(true);
  }, [createWorktreeRequested, clearCreateWorktreeRequest, activeWorktreePath, project.path]);

  // --- @dnd-kit ---
  const [activeDragId, setActiveDragId] = useState<UniqueIdentifier | null>(null);
  const activeDragWt = useMemo(
    () => (activeDragId ? displayedWorktrees.find((wt) => wt.path === activeDragId) : undefined),
    [activeDragId, displayedWorktrees],
  );

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = displayedWorktrees.findIndex((wt) => wt.path === active.id);
      const newIndex = displayedWorktrees.findIndex((wt) => wt.path === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = arrayMove(displayedWorktrees, oldIndex, newIndex);
      setCustomOrder(
        project.path,
        reordered.map((wt) => wt.path),
      );
    },
    [displayedWorktrees, setCustomOrder, project.path],
  );

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
  }, []);

  const handleAddSubmit = useCallback(async () => {
    const name = addName.trim();
    if (!name) return;
    setAddError(null);
    try {
      await createWorktree(project.path, name);
      setAddName("");
      setAddingWorktree(false);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to create worktree");
    }
  }, [addName, createWorktree, project.path]);

  const handleBranchConflictResolve = useCallback(
    async (resolution: "use-existing" | "delete-and-create") => {
      setAddError(null);
      try {
        await confirmCreateWorktree(resolution);
        setAddName("");
        setAddingWorktree(false);
      } catch (err) {
        setAddError(err instanceof Error ? err.message : "Failed to create worktree");
      }
    },
    [confirmCreateWorktree],
  );

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={displayedIds} strategy={verticalListSortingStrategy}>
          <div>
            {worktrees.length === 0 && (
              <div
                className="text-muted-foreground cursor-pointer py-1.5 text-[11px] italic hover:underline"
                style={{ paddingLeft: "40px" }}
                onClick={() => switchWorktree(project.path)}
              >
                Click to load worktrees
              </div>
            )}
            {displayedWorktrees.map((wt) => (
              <WorktreeItem
                key={wt.path}
                wt={wt}
                isActive={wt.path === activeWorktreePath}
                isHidden={hiddenSet.has(wt.path)}
                isDragOverlay={false}
                onSelect={() => !wt.pending && switchWorktree(wt.path)}
                onContextMenu={(e) => !wt.pending && removal.handleContextMenu(e, wt)}
                onToggleVisibility={() => toggleVisibility(project.path, wt.path)}
              />
            ))}

            {/* Add worktree inline input */}
            {addingWorktree ? (
              <div className="flex items-center gap-1 py-1 pr-2" style={{ paddingLeft: "40px" }}>
                <button
                  className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
                  onClick={() => {
                    setAddingWorktree(false);
                    setAddName("");
                    setAddError(null);
                  }}
                  title="Cancel"
                >
                  <XIcon className="size-3.5" />
                </button>
                <div className="min-w-0 flex-1">
                  <input
                    value={addName}
                    onChange={(e) => {
                      setAddName(e.target.value.toLowerCase().replace(/\s/g, "-"));
                      setAddError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAddSubmit();
                      if (e.key === "Escape") {
                        setAddingWorktree(false);
                        setAddName("");
                        setAddError(null);
                      }
                    }}
                    placeholder="worktree name"
                    className="bg-background border-border text-foreground placeholder:text-muted-foreground w-full rounded border px-2 py-1 text-xs outline-none"
                    autoFocus
                  />
                  {addError && <div className="text-destructive mt-1 text-[10px]">{addError}</div>}
                </div>
                <button
                  className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
                  onClick={handleAddSubmit}
                  title="Create worktree"
                >
                  <PlusIcon className="size-3.5" />
                </button>
              </div>
            ) : (
              <div
                className="text-muted-foreground hover:text-foreground hover:bg-primary/50 flex cursor-pointer items-center gap-2 py-1 transition-colors"
                style={{ paddingLeft: "40px" }}
                onClick={() => setAddingWorktree(true)}
              >
                <div className="flex size-5 shrink-0 items-center justify-center">
                  <GitBranchPlusIcon className="size-4" />
                </div>
                <span className="text-[11px]">Add worktree</span>
              </div>
            )}
          </div>
        </SortableContext>

        {/* Drag overlay */}
        <DragOverlay dropAnimation={{ duration: 200, easing: "ease" }}>
          {activeDragWt ? (
            <WorktreeItem
              wt={activeDragWt}
              isActive={activeDragWt.path === activeWorktreePath}
              isHidden={hiddenSet.has(activeDragWt.path)}
              isDragOverlay
              onSelect={() => {}}
              onContextMenu={() => {}}
              onToggleVisibility={() => {}}
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      <WorktreeRemoveDialogs removal={removal} />

      {/* Branch conflict resolution dialog */}
      {pendingAddPlan?.branchConflict?.kind === "exists-unused" && (
        <BranchConflictDialog
          branchName={pendingAddPlan.branchConflict.branchName}
          error={addError}
          onResolve={handleBranchConflictResolve}
          onCancel={() => {
            dismissPendingPlan();
            setAddError(null);
          }}
        />
      )}
    </>
  );
}

// ── Worktree Item ───────────────────────────────────────────────────────

function WorktreeItem({
  wt,
  isActive,
  isHidden,
  isDragOverlay,
  onSelect,
  onContextMenu,
  onToggleVisibility,
}: {
  wt: WorktreeEntry;
  isActive: boolean;
  isHidden: boolean;
  isDragOverlay: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onToggleVisibility: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: wt.path,
    disabled: isDragOverlay,
  });
  const hasNotification = usePanelNotificationStore((s) => hasWorktreeNotification(s, wt.path));

  const name = worktreeName(wt);
  const subtitle = worktreeSubtitle(wt);
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    paddingLeft: "36px",
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "hover:bg-primary/50 group relative flex cursor-pointer items-center gap-2 px-2 py-1 transition-colors",
        isActive && "bg-primary",
        isHidden && "opacity-40",
        isDragging && "z-10 opacity-30",
        isDragOverlay && "bg-card border-border rounded-md border shadow-lg",
        wt.pending && "opacity-50",
      )}
      title={wt.path}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      {...attributes}
      {...listeners}
    >
      <div className="relative shrink-0">
        <WorktreeIcon name={name} size="sm" />
        {hasNotification && !isActive && <NotificationDot />}
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="text-foreground truncate text-xs font-medium">{name}</div>
        <div className="text-muted-foreground truncate text-[10px]">
          {wt.pending ? "Creating..." : subtitle}
        </div>
      </div>
      {!isDragOverlay && (
        <button
          className={cn(
            "text-muted-foreground hover:text-foreground shrink-0 cursor-pointer transition-opacity",
            isHidden ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
          onClick={(e) => {
            e.stopPropagation();
            onToggleVisibility();
          }}
          title={isHidden ? "Show in collapsed view" : "Hide from collapsed view"}
        >
          {isHidden ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
        </button>
      )}
    </div>
  );
}

// ── Enhanced Remove Dialog ─────────────────────────────────────────────

function RemoveWorktreeDialog({
  plan,
  error,
  onConfirm,
  onCancel,
}: {
  plan: NonNullable<ReturnType<typeof useWorktreeStore.getState>["pendingRemovePlan"]>;
  error: string | null;
  onConfirm: (deleteBranch: boolean) => void;
  onCancel: () => void;
}) {
  const status = plan.status;
  const canDeleteBranch = plan.branchDeletionApplicable && plan.branch;
  const showBranchInfo = canDeleteBranch && plan.branch !== plan.name;

  return (
    <DialogShell open onCancel={onCancel} className="w-96">
      <div className="px-4 pt-4 pb-2">
        <h3 className="text-foreground text-sm font-medium">Remove worktree</h3>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
          Delete worktree{" "}
          <span className="text-foreground font-medium break-words">{plan.name}</span>?
          {showBranchInfo && (
            <>
              <br />
              Current branch:{" "}
              <span className="text-foreground font-medium break-words">{plan.branch}</span>
            </>
          )}
        </p>

        {status && (
          <div className="border-warning/20 bg-warning/5 mt-3 rounded-md border p-2.5">
            <p className="text-warning text-[11px] font-medium">
              This worktree has local changes that will be lost:
            </p>
            <ul className="text-muted-foreground mt-1.5 space-y-0.5 text-[10px]">
              {status.untrackedFiles.length > 0 && (
                <li>
                  {status.untrackedFiles.length} untracked file
                  {status.untrackedFiles.length === 1 ? "" : "s"}
                </li>
              )}
              {status.stagedCount > 0 && (
                <li>
                  {status.stagedCount} staged change{status.stagedCount === 1 ? "" : "s"}
                </li>
              )}
              {status.unstagedCount > 0 && (
                <li>
                  {status.unstagedCount} modified file{status.unstagedCount === 1 ? "" : "s"}
                </li>
              )}
              {status.aheadCount === null && plan.branch && (
                <li>Branch &ldquo;{plan.branch}&rdquo; has never been pushed</li>
              )}
              {status.aheadCount !== null && status.aheadCount > 0 && (
                <li>
                  {status.aheadCount} unpushed commit{status.aheadCount === 1 ? "" : "s"}
                </li>
              )}
            </ul>
          </div>
        )}

        {error && <div className="text-destructive mt-2 text-[10px]">{error}</div>}
      </div>

      <div className="flex flex-col gap-1.5 px-4 py-3">
        <Button
          variant="destructive-outline"
          size="xs"
          className="w-full"
          onClick={() => onConfirm(false)}
        >
          Delete worktree only
        </Button>
        {canDeleteBranch && (
          <Button
            variant="destructive-outline"
            size="xs"
            className="w-full"
            onClick={() => onConfirm(true)}
          >
            Delete worktree and branch
          </Button>
        )}
        <Button variant="outline" size="xs" className="w-full" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </DialogShell>
  );
}

// ── Branch Conflict Dialog ─────────────────────────────────────────────

function BranchConflictDialog({
  branchName,
  error,
  onResolve,
  onCancel,
}: {
  branchName: string;
  error: string | null;
  onResolve: (resolution: "use-existing" | "delete-and-create") => void;
  onCancel: () => void;
}) {
  return (
    <DialogShell open onCancel={onCancel} className="w-80">
      <div className="px-4 pt-4 pb-2">
        <h3 className="text-foreground text-sm font-medium">Branch already exists</h3>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
          Branch &ldquo;{branchName}&rdquo; already exists. How would you like to proceed?
        </p>
        {error && <div className="text-destructive mt-2 text-[10px]">{error}</div>}
      </div>

      <div className="flex flex-col gap-1.5 px-4 py-3">
        <Button
          variant="default"
          size="xs"
          className="w-full"
          onClick={() => onResolve("use-existing")}
        >
          Use existing branch
        </Button>
        <Button
          variant="outline"
          size="xs"
          className="w-full"
          onClick={() => onResolve("delete-and-create")}
        >
          Delete and recreate branch
        </Button>
        <Button variant="ghost" size="xs" className="w-full" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </DialogShell>
  );
}
