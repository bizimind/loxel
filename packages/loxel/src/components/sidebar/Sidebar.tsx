/**
 * Unified sidebar — shows all projects with their worktrees as collapsible groups.
 * Every project can expand to show linked worktrees; a non-bare project's
 * header remains the switch target for its root checkout.
 * Replaces the separate ProjectSidebar and WorktreeSidebar components.
 */
import type { DragEndEvent, DragMoveEvent, DragStartEvent, UniqueIdentifier } from "@dnd-kit/core";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowUpToLineIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  GitBranchPlusIcon,
  ListTreeIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { WorktreeEntry } from "@/api/git-models";
import type { Project } from "@/api/project-model";
import type { NestedRemoval } from "@/api/worktree-removal-model";
import { OpenInMenuItems, isOpenInSupported } from "@/components/menus/OpenInMenuItems";
import { InlineRenameInput, TREE_INDENT_STEP } from "@/components/tree";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { DialogShell } from "@/components/ui/dialog-shell";
import { NotificationDot } from "@/components/ui/notification-dot";
import { copyToClipboard } from "@/lib/clipboard";
import { dayjs } from "@/lib/dayjs";
import { FileTypeIcon } from "@/lib/file-icons";
import { handleSidebarEntryKeyDown } from "@/lib/focus-navigation";
import { focusAreaProps, sidebarEntryProps } from "@/lib/focus-targets";
import { frontendLog } from "@/lib/frontend-logger";
import { abbreviateHomePath } from "@/lib/home-path";
import { cn } from "@/lib/utils";
import { moveInOrder, resolveParents, type WorktreeRow } from "@/lib/worktree-hierarchy";
import { hasWorktreeNotification, usePanelNotificationStore } from "@/store/panel-notifications";
import {
  clampSidebarWidth,
  deriveProject,
  SIDEBAR_DEFAULT_WIDTH,
  useProjectStore,
} from "@/store/projects";
import {
  getOrderedWorktrees,
  getWorktreeRows,
  useWorktreeStore,
  type ProjectState,
} from "@/store/worktrees";

import { AddProjectWizard } from "../projects/AddProjectWizard";
import { ProjectIcon } from "../projects/ProjectIcon";
import { WorktreeIcon } from "../worktrees/WorktreeIcon";
import { EnableNestingDialog } from "./EnableNestingDialog";
import { SidebarResizeHandle } from "./SidebarResizeHandle";

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
/** Keyboard cursor ring for the collapsed rail's icon buttons. */
const ENTRY_FOCUS_RING =
  "focus-visible:ring-ring focus-visible:ring-offset-card outline-none focus-visible:ring-2 focus-visible:ring-offset-2";
const EMPTY_WORKTREES: WorktreeEntry[] = [];
const EMPTY_PROJECT_STATE: ProjectState = { worktrees: EMPTY_WORKTREES };

// ── Shared worktree context menu hook ───────────────────────────────────

function useWorktreeContextMenu(projectPath: string) {
  const requestRemoveWorktree = useWorktreeStore((s) => s.requestRemoveWorktree);
  const confirmRemoveWorktree = useWorktreeStore((s) => s.confirmRemoveWorktree);
  const setWorktreeParent = useWorktreeStore((s) => s.setWorktreeParent);
  const dismissPendingPlan = useWorktreeStore((s) => s.dismissPendingPlan);
  const pendingRemovePlan = useWorktreeStore((s) =>
    s.pendingRemovePlan?.projectPath === projectPath ? s.pendingRemovePlan : null,
  );

  const [contextMenu, setContextMenu] = useState<{
    open: boolean;
    position: { x: number; y: number };
    worktree: WorktreeEntry;
  } | null>(null);
  /** Error of the last remove, move or rename; shown in the remove dialog while it is open. */
  const [error, setError] = useState<string | null>(null);
  const [enablingNesting, setEnablingNesting] = useState(false);

  const handleContextMenu = useCallback((e: React.MouseEvent, wt: WorktreeEntry) => {
    e.preventDefault();
    setContextMenu({ open: true, position: { x: e.clientX, y: e.clientY }, worktree: wt });
  }, []);

  const handleRemoveRequest = useCallback(
    async (wt: WorktreeEntry) => {
      setContextMenu(null);
      setError(null);
      try {
        await requestRemoveWorktree(projectPath, wt);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to inspect worktree");
      }
    },
    [requestRemoveWorktree, projectPath],
  );

  const handlePlanRemoveConfirm = useCallback(
    async (options: { deleteBranch: boolean; force: boolean; nested: NestedRemoval }) => {
      setError(null);
      try {
        await confirmRemoveWorktree(options);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to remove worktree");
      }
    },
    [confirmRemoveWorktree],
  );

  /** Nest `path` under `parentPath`, or move it to the top level. */
  const handleSetParent = useCallback(
    async (path: string, parentPath: string | null) => {
      setContextMenu(null);
      setError(null);
      try {
        await setWorktreeParent(projectPath, path, parentPath);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to move worktree");
      }
    },
    [setWorktreeParent, projectPath],
  );

  return {
    projectPath,
    contextMenu,
    setContextMenu,
    error,
    setError,
    enablingNesting,
    setEnablingNesting,
    pendingRemovePlan,
    dismissPendingPlan,
    handleContextMenu,
    handleRemoveRequest,
    handlePlanRemoveConfirm,
    handleSetParent,
  };
}

/**
 * Renders the worktree context menu (copy, nesting, hide/show, remove) + removal dialogs.
 * `onNewChild` and `onRename` need the expanded list's inline inputs, so the rail omits them.
 */
function WorktreeContextMenu({
  menu,
  onNewChild,
  onRename,
}: {
  menu: ReturnType<typeof useWorktreeContextMenu>;
  onNewChild?: (wt: WorktreeEntry) => void;
  onRename?: (wt: WorktreeEntry) => void;
}) {
  const toggleVisibility = useWorktreeStore((s) => s.toggleVisibility);
  const wt = menu.contextMenu?.worktree;
  const isHidden = useWorktreeStore(
    (s) =>
      wt !== undefined && (s.byProject[menu.projectPath]?.hiddenPaths?.includes(wt.path) ?? false),
  );
  const nesting = useWorktreeStore((s) => s.byProject[menu.projectPath]?.worktreeMetadata);
  const isNested = useWorktreeStore(
    (s) =>
      wt?.parentWtId !== undefined &&
      (s.byProject[menu.projectPath]?.worktrees.some(
        (other) => other.wtId === wt.parentWtId && other.path !== wt.path,
      ) ??
        false),
  );

  const close = () => menu.setContextMenu(null);

  return (
    <>
      {/* Worktree context menu */}
      {menu.contextMenu && wt && (
        <ContextMenu
          open={menu.contextMenu.open}
          onOpenChange={(open) => !open && close()}
          position={menu.contextMenu.position}
        >
          <ContextMenuItem onClick={() => copyToClipboard(worktreeName(wt), "worktree name")}>
            <CopyIcon className="size-3.5" />
            Copy worktree name
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!wt.branch}
            onClick={() => wt.branch && copyToClipboard(wt.branch, "branch name")}
          >
            <GitBranchIcon className="size-3.5" />
            Copy branch name
          </ContextMenuItem>
          <ContextMenuItem onClick={() => copyToClipboard(wt.path, "worktree path")}>
            <FolderIcon className="size-3.5" />
            Copy absolute path
          </ContextMenuItem>
          {isOpenInSupported && <ContextMenuSeparator />}
          <OpenInMenuItems path={wt.path} />
          <ContextMenuSeparator />
          {nesting ? (
            <>
              {onNewChild && (
                <ContextMenuItem
                  onClick={() => {
                    close();
                    onNewChild(wt);
                  }}
                >
                  <GitBranchPlusIcon className="size-3.5" />
                  New child worktree
                </ContextMenuItem>
              )}
              {onRename && (
                <ContextMenuItem
                  onClick={() => {
                    close();
                    onRename(wt);
                  }}
                >
                  <PencilIcon className="size-3.5" />
                  Rename
                </ContextMenuItem>
              )}
              {isNested && (
                <ContextMenuItem onClick={() => menu.handleSetParent(wt.path, null)}>
                  <ArrowUpToLineIcon className="size-3.5" />
                  Move to top level
                </ContextMenuItem>
              )}
            </>
          ) : (
            <ContextMenuItem
              onClick={() => {
                close();
                menu.setEnablingNesting(true);
              }}
            >
              <ListTreeIcon className="size-3.5" />
              Enable worktree nesting…
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={() => toggleVisibility(menu.projectPath, wt.path)}>
            {isHidden ? <EyeIcon className="size-3.5" /> : <EyeOffIcon className="size-3.5" />}
            {isHidden ? "Show worktree" : "Hide worktree"}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => menu.handleRemoveRequest(wt)}>
            <TrashIcon className="size-3.5" />
            Remove worktree
          </ContextMenuItem>
        </ContextMenu>
      )}

      {/* Remove dialog (wt library plan) */}
      {menu.pendingRemovePlan && (
        <RemoveWorktreeDialog
          plan={menu.pendingRemovePlan}
          error={menu.error}
          onConfirm={menu.handlePlanRemoveConfirm}
          onCancel={() => {
            menu.dismissPendingPlan();
            menu.setError(null);
          }}
        />
      )}

      {menu.enablingNesting && (
        <EnableNestingDialog
          projectPath={menu.projectPath}
          onClose={() => menu.setEnablingNesting(false)}
        />
      )}

      {/* Global error toast */}
      {menu.error && !menu.pendingRemovePlan && (
        <div className="text-destructive absolute right-2 bottom-2 left-2 text-[10px]">
          {menu.error}
        </div>
      )}
    </>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** The worktree's own name, as `wt` knows it. */
function worktreeName(wt: WorktreeEntry): string {
  return wt.wtName ?? wt.branch ?? wt.path.split("/").pop() ?? "worktree";
}

/** The name the sidebar shows: the display name when one is set. */
function worktreeLabel(wt: WorktreeEntry): string {
  return wt.displayName ?? worktreeName(wt);
}

function worktreeSubtitle(wt: WorktreeEntry, homeDir: string | null): string {
  if (wt.createdAt) return dayjs(wt.createdAt).fromNow();
  return abbreviateHomePath(wt.path, homeDir);
}

// ── Main Sidebar ────────────────────────────────────────────────────────

export function Sidebar() {
  const projects = useProjectStore((s) => s.projects);
  const homeDir = useProjectStore((s) => s.homeDir);
  const sidebarExpanded = useProjectStore((s) => s.sidebarExpanded);
  const sidebarWidth = useProjectStore((s) => s.sidebarWidth);
  const setSidebarWidth = useProjectStore((s) => s.setSidebarWidth);
  const expandedProjectIds = useProjectStore((s) => s.expandedProjectIds);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);
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
      style={{ width: sidebarExpanded ? expandedWidth : COLLAPSED_WIDTH }}
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
      <div
        className="flex-1 overflow-x-hidden overflow-y-auto"
        onKeyDown={handleSidebarEntryKeyDown}
      >
        {projects.map((project) => {
          const isRootActive = activeWorktreePath === project.path;
          const isExpanded = expandedSet.has(project.id);
          const isRenaming = project.id === renamingId;

          if (sidebarExpanded) {
            return (
              <div key={project.id}>
                {/* Project header row */}
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

                {isExpanded && <WorktreeList project={project} />}
              </div>
            );
          }

          // Collapsed mode — show project icon, with worktree icons underneath if expanded
          return (
            <div key={project.id}>
              <div className="flex justify-center py-1.5" style={{ paddingLeft: "3px" }}>
                <button
                  className={cn("cursor-pointer rounded-md", ENTRY_FOCUS_RING)}
                  onClick={() => handleProjectClick(project)}
                  {...sidebarEntryProps(project.path)}
                  onContextMenu={(e) => handleProjectContextMenu(e, project)}
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
              {isExpanded && (
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

// ── Collapsed Worktree List ──────────────────────────────────────────────

/** The top of `path`'s subtree: the top-level worktree it is nested under, or itself. */
function topLevelAncestor(path: string, parents: ReadonlyMap<string, string | null>): string {
  let current = path;
  for (let parent = parents.get(current); parent; parent = parents.get(current)) current = parent;
  return current;
}

function CollapsedWorktreeList({
  project,
  activeWorktreePath,
}: {
  project: Project;
  activeWorktreePath: string | null;
}) {
  const ps = useWorktreeStore((s) => s.byProject[project.path]) ?? EMPTY_PROJECT_STATE;
  const switchWorktree = useWorktreeStore((s) => s.switchWorktree);
  const setCustomOrder = useWorktreeStore((s) => s.setCustomOrder);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);

  const menu = useWorktreeContextMenu(project.path);

  // Only top-level worktrees: a nested one is reached through the expanded sidebar.
  const rows = useMemo(() => getWorktreeRows({ ...ps, collapsedPaths: undefined }), [ps]);
  const parents = useMemo(() => new Map(rows.map((row) => [row.wt.path, row.parent])), [rows]);
  const visibleRows = useMemo(() => rows.filter((row) => row.depth === 0 && !row.hidden), [rows]);
  const displayedIds = useMemo(() => visibleRows.map((row) => row.wt.path), [visibleRows]);
  const activeTop = activeWorktreePath ? topLevelAncestor(activeWorktreePath, parents) : null;

  const [activeDragId, setActiveDragId] = useState<UniqueIdentifier | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = displayedIds.indexOf(String(active.id));
      const newIndex = displayedIds.indexOf(String(over.id));
      if (oldIndex === -1 || newIndex === -1) return;
      // Hidden and nested worktrees keep their place in the order.
      const orderedPaths = getOrderedWorktrees(ps.worktrees, ps.customOrder).map((wt) => wt.path);
      setCustomOrder(
        project.path,
        moveInOrder(
          orderedPaths,
          String(active.id),
          String(over.id),
          oldIndex < newIndex ? "after" : "before",
        ),
      );
    },
    [displayedIds, ps.worktrees, ps.customOrder, setCustomOrder, project.path],
  );

  const draggedRow = visibleRows.find((row) => row.wt.path === activeDragId);

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
            {visibleRows.map(({ wt, descendantCount }) => (
              <SortableCollapsedIcon
                key={wt.path}
                id={wt.path}
                name={worktreeName(wt)}
                label={worktreeLabel(wt)}
                nestedCount={descendantCount}
                notifyPaths={subtreePaths(wt.path, rows)}
                isActive={wt.path === activeTop}
                isPending={wt.pending !== undefined}
                onClick={() => !wt.pending && switchWorktree(wt.path)}
                onContextMenu={(e) => !wt.pending && menu.handleContextMenu(e, wt)}
              />
            ))}
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
          {draggedRow ? (
            <WorktreeIcon name={worktreeName(draggedRow.wt)} size="md" active={false} />
          ) : null}
        </DragOverlay>
      </DndContext>

      <WorktreeContextMenu menu={menu} />
    </>
  );
}

/** `path` and every worktree nested below it, from rows built with nothing collapsed. */
function subtreePaths(path: string, rows: readonly WorktreeRow<WorktreeEntry>[]): string[] {
  const inSubtree = new Set([path]);
  for (const row of rows) {
    if (row.parent !== null && inSubtree.has(row.parent)) inSubtree.add(row.wt.path);
  }
  return [...inSubtree];
}

/** Sortable wrapper for CollapsedWorktreeIcon. */
function SortableCollapsedIcon(props: CollapsedWorktreeIconProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <CollapsedWorktreeIcon {...props} />
    </div>
  );
}

interface CollapsedWorktreeIconProps {
  id: string;
  /** The worktree name the icon is drawn from */
  name: string;
  /** The name shown on hover */
  label: string;
  /** Worktrees nested below it, at any depth */
  nestedCount: number;
  /** Worktrees whose notifications the icon shows: its own and its nested ones' */
  notifyPaths: readonly string[];
  isActive: boolean;
  isPending: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function CollapsedWorktreeIcon({
  id,
  name,
  label,
  nestedCount,
  notifyPaths,
  isActive,
  isPending,
  onClick,
  onContextMenu,
}: CollapsedWorktreeIconProps) {
  const [hovered, setHovered] = useState(false);
  const [labelPos, setLabelPos] = useState({ top: 0, left: 0 });

  const handleMouseEnter = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setLabelPos({ top: rect.top + rect.height / 2, left: rect.right + 8 });
    setHovered(true);
  }, []);

  const hasNotification = usePanelNotificationStore((s) =>
    notifyPaths.some((path) => hasWorktreeNotification(s, path)),
  );
  const nestedLabel = nestedCount === 1 ? "1 nested worktree" : `${nestedCount} nested worktrees`;

  return (
    <>
      <div className="flex justify-center py-1">
        <button
          className={cn(
            "relative cursor-pointer rounded-md",
            ENTRY_FOCUS_RING,
            isPending && "opacity-50",
          )}
          onClick={onClick}
          {...(isPending ? undefined : sidebarEntryProps(id))}
          onContextMenu={onContextMenu}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={() => setHovered(false)}
        >
          <WorktreeIcon name={name} size="md" active={isActive} />
          {hasNotification && !isActive && <NotificationDot />}
          {nestedCount > 0 && (
            <span
              className="bg-muted text-muted-foreground border-card absolute -right-1.5 -bottom-1 min-w-3.5 rounded-full border px-0.5 text-center text-[9px] leading-3"
              aria-label={nestedLabel}
            >
              {nestedCount}
            </span>
          )}
        </button>
      </div>
      {hovered &&
        createPortal(
          <div
            className="animate-in fade-in slide-in-from-left-1 pointer-events-none fixed z-[9999] -translate-y-1/2 duration-150"
            style={{ top: labelPos.top, left: labelPos.left }}
          >
            <div className="bg-popover border-border text-foreground rounded-md border px-2.5 py-1 text-xs font-medium whitespace-nowrap shadow-lg">
              {label}
              {nestedCount > 0 && (
                <span className="text-muted-foreground ml-1.5 font-normal">({nestedLabel})</span>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

// ── Worktree List (for expanded projects) ────────────────────────────────

/** Where a dragged worktree lands: nested inside a row, or just before or after it. */
type DropZone = "before" | "after" | "inside";
interface DropTarget {
  path: string;
  zone: DropZone;
}

/** The inline "new worktree" input: at the bottom, or under the worktree it nests the new one in. */
interface AddingState {
  parentPath?: string;
}

function WorktreeList({ project }: { project: Project }) {
  const ps = useWorktreeStore((s) => s.byProject[project.path]) ?? EMPTY_PROJECT_STATE;
  const worktrees = ps.worktrees;
  const nesting = ps.worktreeMetadata ?? false;
  const activeWorktreePath = useWorktreeStore((s) => s.activeWorktreePath);
  const switchWorktree = useWorktreeStore((s) => s.switchWorktree);
  const createWorktree = useWorktreeStore((s) => s.createWorktree);
  const confirmCreateWorktree = useWorktreeStore((s) => s.confirmCreateWorktree);
  const renameWorktree = useWorktreeStore((s) => s.renameWorktree);
  const dismissPendingPlan = useWorktreeStore((s) => s.dismissPendingPlan);
  const pendingAddPlan = useWorktreeStore((s) =>
    s.pendingAddPlan?.projectPath === project.path ? s.pendingAddPlan : null,
  );
  const setCustomOrder = useWorktreeStore((s) => s.setCustomOrder);
  const toggleVisibility = useWorktreeStore((s) => s.toggleVisibility);
  const toggleCollapsed = useWorktreeStore((s) => s.toggleCollapsed);
  const createWorktreeRequested = useWorktreeStore((s) => s.createWorktreeRequested);
  const clearCreateWorktreeRequest = useWorktreeStore((s) => s.clearCreateWorktreeRequest);

  const menu = useWorktreeContextMenu(project.path);
  const { handleSetParent, setError: setMenuError } = menu;

  const rows = useMemo(() => getWorktreeRows(ps), [ps]);
  /** Every row, collapsed subtrees included, for checks that span hidden levels. */
  const fullRows = useMemo(() => getWorktreeRows({ ...ps, collapsedPaths: undefined }), [ps]);
  const rowByPath = useMemo(() => new Map(rows.map((row) => [row.wt.path, row])), [rows]);
  const hiddenSet = useMemo(() => new Set(ps.hiddenPaths), [ps.hiddenPaths]);

  const [adding, setAdding] = useState<AddingState | null>(null);
  const [addName, setAddName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const addInputRef = useRef<HTMLInputElement>(null);

  // Focus on the next tick: a context menu that opened the input returns focus to where it was
  // when it closes, after this render.
  useEffect(() => {
    if (!adding) return;
    const timeout = window.setTimeout(() => addInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timeout);
  }, [adding]);

  // Respond to keybinding-triggered create request
  useEffect(() => {
    if (!createWorktreeRequested) return;
    const activeProject = deriveProject(activeWorktreePath, useProjectStore.getState().projects);
    if (activeProject?.path !== project.path) return;
    clearCreateWorktreeRequest();
    setAdding({});
  }, [createWorktreeRequested, clearCreateWorktreeRequest, activeWorktreePath, project.path]);

  const cancelAdding = useCallback(() => {
    setAdding(null);
    setAddName("");
    setAddError(null);
  }, []);

  const handleNewChild = useCallback(
    (wt: WorktreeEntry) => {
      if (rowByPath.get(wt.path)?.collapsed) toggleCollapsed(project.path, wt.path);
      setAddName("");
      setAddError(null);
      setAdding({ parentPath: wt.path });
    },
    [rowByPath, toggleCollapsed, project.path],
  );

  const handleRenameStart = useCallback((wt: WorktreeEntry) => setRenamingPath(wt.path), []);

  const handleRenameFinish = useCallback(
    async (wt: WorktreeEntry, value: string) => {
      setRenamingPath(null);
      try {
        // Renaming back to the worktree's own name clears the display name.
        await renameWorktree(project.path, wt.path, value === worktreeName(wt) ? "" : value);
      } catch (err) {
        setMenuError(err instanceof Error ? err.message : "Failed to rename worktree");
      }
    },
    [renameWorktree, project.path, setMenuError],
  );

  // --- @dnd-kit: drop onto a row to nest, between rows to reorder siblings ---
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const draggedRow = activeDragId ? rowByPath.get(activeDragId) : undefined;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  }, []);

  /** The drop the pointer is over, or null where dropping would do nothing. */
  const resolveDropTarget = useCallback(
    (event: DragMoveEvent): DropTarget | null => {
      const { active, over, activatorEvent, delta } = event;
      if (!over || !(activatorEvent instanceof MouseEvent)) return null;
      const moved = rowByPath.get(String(active.id));
      const target = rowByPath.get(String(over.id));
      if (!moved || !target || moved === target) return null;

      const ratio = (activatorEvent.clientY + delta.y - over.rect.top) / over.rect.height;
      // Not under itself or anything below it, and not where it already is.
      const canNest =
        nesting &&
        !subtreePaths(moved.wt.path, fullRows).includes(target.wt.path) &&
        moved.parent !== target.wt.path;
      const siblings = moved.parent === target.parent;
      if (canNest && (!siblings || (ratio > 0.25 && ratio < 0.75))) {
        return { path: target.wt.path, zone: "inside" };
      }
      if (!siblings) return null;
      return { path: target.wt.path, zone: ratio < 0.5 ? "before" : "after" };
    },
    [rowByPath, nesting, fullRows],
  );

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      const next = resolveDropTarget(event);
      setDropTarget((current) =>
        current?.path === next?.path && current?.zone === next?.zone ? current : next,
      );
    },
    [resolveDropTarget],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const target = resolveDropTarget(event);
      setActiveDragId(null);
      setDropTarget(null);
      if (!target) return;
      const moved = String(event.active.id);
      if (target.zone === "inside") {
        void handleSetParent(moved, target.path);
        return;
      }
      const orderedPaths = getOrderedWorktrees(ps.worktrees, ps.customOrder).map((wt) => wt.path);
      setCustomOrder(project.path, moveInOrder(orderedPaths, moved, target.path, target.zone));
    },
    [
      resolveDropTarget,
      handleSetParent,
      ps.worktrees,
      ps.customOrder,
      setCustomOrder,
      project.path,
    ],
  );

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
    setDropTarget(null);
  }, []);

  const handleAddSubmit = useCallback(async () => {
    const name = addName.trim();
    if (!name) return;
    setAddError(null);
    try {
      await createWorktree(project.path, name, { parentPath: adding?.parentPath });
      cancelAdding();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to create worktree");
    }
  }, [addName, createWorktree, project.path, adding, cancelAdding]);

  const handleBranchConflictResolve = useCallback(
    async (resolution: "use-existing" | "delete-and-create") => {
      setAddError(null);
      try {
        await confirmCreateWorktree(resolution);
        cancelAdding();
      } catch (err) {
        setAddError(err instanceof Error ? err.message : "Failed to create worktree");
      }
    },
    [confirmCreateWorktree, cancelAdding],
  );

  const addInput = (depth: number) => (
    <div
      className="flex items-center gap-1 py-1 pr-2"
      style={{ paddingLeft: `${WORKTREE_INDENT + depth * TREE_INDENT_STEP}px` }}
    >
      <button
        className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
        onClick={cancelAdding}
        title="Cancel"
      >
        <XIcon className="size-3.5" />
      </button>
      <div className="min-w-0 flex-1">
        <input
          ref={addInputRef}
          value={addName}
          onChange={(e) => {
            setAddName(e.target.value.toLowerCase().replace(/\s/g, "-"));
            setAddError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAddSubmit();
            if (e.key === "Escape") cancelAdding();
          }}
          placeholder={adding?.parentPath ? "child worktree name" : "worktree name"}
          className="bg-background border-border text-foreground placeholder:text-muted-foreground w-full rounded border px-2 py-1 text-xs outline-none"
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
  );

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        modifiers={[restrictToVerticalAxis]}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div>
          {/* A bare repo's list is empty until its worktrees are fetched; a regular repo's
              main checkout is never listed, so for it an empty list is the normal state and
              the "Add worktree" row below is the affordance. */}
          {project.isBare && worktrees.length === 0 && (
            <div
              className="text-muted-foreground cursor-pointer py-1.5 text-[11px] italic hover:underline"
              style={{ paddingLeft: `${WORKTREE_INDENT + 4}px` }}
              onClick={() => switchWorktree(project.path)}
            >
              Click to load worktrees
            </div>
          )}
          {rows.map((row, index) => {
            const { wt } = row;
            // The child input goes after the parent's whole visible subtree.
            const next = rows[index + 1];
            const endsAddingSubtree =
              adding?.parentPath !== undefined &&
              (wt.path === adding.parentPath || subtreeOf(rows, adding.parentPath).has(wt.path)) &&
              (!next || !subtreeOf(rows, adding.parentPath).has(next.wt.path));
            const parentDepth = rowByPath.get(adding?.parentPath ?? "")?.depth ?? 0;
            return (
              <Fragment key={wt.path}>
                <DraggableWorktreeItem
                  row={row}
                  isActive={wt.path === activeWorktreePath}
                  isOwnHidden={hiddenSet.has(wt.path)}
                  isDragging={wt.path === activeDragId}
                  // A folded worktree also shows its hidden nested worktrees' notifications.
                  notifyPaths={row.collapsed ? subtreePaths(wt.path, fullRows) : [wt.path]}
                  dropZone={dropTarget?.path === wt.path ? dropTarget.zone : null}
                  isRenaming={renamingPath === wt.path}
                  onRenameFinish={(value) => handleRenameFinish(wt, value)}
                  onRenameCancel={() => setRenamingPath(null)}
                  onSelect={() => !wt.pending && switchWorktree(wt.path)}
                  onContextMenu={(e) => !wt.pending && menu.handleContextMenu(e, wt)}
                  onToggleVisibility={() => toggleVisibility(project.path, wt.path)}
                  onToggleCollapsed={() => toggleCollapsed(project.path, wt.path)}
                />
                {endsAddingSubtree && addInput(parentDepth + 1)}
              </Fragment>
            );
          })}

          {/* Add worktree inline input */}
          {adding && adding.parentPath === undefined ? (
            addInput(0)
          ) : (
            <div
              className="text-muted-foreground hover:text-foreground hover:bg-primary/50 flex cursor-pointer items-center gap-2 py-1 transition-colors"
              style={{ paddingLeft: `${WORKTREE_INDENT + 4}px` }}
              onClick={() => {
                cancelAdding();
                setAdding({});
              }}
            >
              <div className="flex size-5 shrink-0 items-center justify-center">
                <GitBranchPlusIcon className="size-4" />
              </div>
              <span className="text-[11px]">Add worktree</span>
            </div>
          )}
        </div>

        {/* Drag overlay */}
        <DragOverlay dropAnimation={{ duration: 200, easing: "ease" }}>
          {draggedRow ? (
            <WorktreeItemView
              row={{ ...draggedRow, depth: 0 }}
              isActive={draggedRow.wt.path === activeWorktreePath}
              isOwnHidden={hiddenSet.has(draggedRow.wt.path)}
              isDragOverlay
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      <WorktreeContextMenu menu={menu} onNewChild={handleNewChild} onRename={handleRenameStart} />

      {/* Branch conflict resolution dialog */}
      {pendingAddPlan?.branchConflict?.kind === "exists" && (
        <BranchConflictDialog
          branchName={pendingAddPlan.branch}
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

/** The visible rows below `path`. */
function subtreeOf(rows: readonly WorktreeRow<WorktreeEntry>[], path: string): Set<string> {
  return new Set(subtreePaths(path, rows).filter((p) => p !== path));
}

// ── Worktree Item ───────────────────────────────────────────────────────

/** Left padding of a top-level worktree row; each nesting level adds `TREE_INDENT_STEP`. */
const WORKTREE_INDENT = 36;

interface WorktreeItemViewProps {
  row: WorktreeRow<WorktreeEntry>;
  isActive: boolean;
  /** Hidden itself (the row is also dimmed when an ancestor is hidden) */
  isOwnHidden: boolean;
  isDragOverlay?: boolean;
  isDragging?: boolean;
  /** Worktrees whose notifications the row shows; just its own by default */
  notifyPaths?: readonly string[];
  dropZone?: DropZone | null;
  /** Shows the inline display-name input */
  isRenaming?: boolean;
  onRenameFinish?: (value: string) => void;
  onRenameCancel?: () => void;
  onSelect?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onToggleVisibility?: () => void;
  onToggleCollapsed?: () => void;
  /** Ref and drag handlers of the draggable, droppable row */
  rootRef?: (node: HTMLElement | null) => void;
  rootProps?: React.HTMLAttributes<HTMLDivElement>;
}

/** A worktree row that can be dragged, and dropped onto or next to. */
function DraggableWorktreeItem(props: WorktreeItemViewProps) {
  const path = props.row.wt.path;
  const disabled = props.row.wt.pending !== undefined || props.isRenaming === true;
  const drag = useDraggable({ id: path, disabled });
  const drop = useDroppable({ id: path, disabled: props.row.wt.pending !== undefined });
  const rootRef = useCallback(
    (node: HTMLElement | null) => {
      drag.setNodeRef(node);
      drop.setNodeRef(node);
    },
    [drag.setNodeRef, drop.setNodeRef],
  );
  return (
    <WorktreeItemView
      {...props}
      rootRef={rootRef}
      rootProps={{ ...drag.attributes, ...drag.listeners }}
    />
  );
}

function WorktreeItemView({
  row,
  isActive,
  isOwnHidden,
  isDragOverlay = false,
  isDragging = false,
  notifyPaths,
  dropZone = null,
  isRenaming = false,
  onRenameFinish,
  onRenameCancel,
  onSelect,
  onContextMenu,
  onToggleVisibility,
  onToggleCollapsed,
  rootRef,
  rootProps,
}: WorktreeItemViewProps) {
  const { wt, depth, descendantCount, collapsed, hidden } = row;
  const hasNotification = usePanelNotificationStore((s) =>
    (notifyPaths ?? [wt.path]).some((path) => hasWorktreeNotification(s, path)),
  );
  const homeDir = useProjectStore((s) => s.homeDir);
  const label = worktreeLabel(wt);
  const subtitle = worktreeSubtitle(wt, homeDir);
  const indent = WORKTREE_INDENT + depth * TREE_INDENT_STEP;

  return (
    <div
      ref={rootRef}
      style={{ paddingLeft: `${indent}px` }}
      className={cn(
        "hover:bg-primary/50 group focus-visible:ring-ring relative flex cursor-pointer items-center gap-2 px-2 py-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset",
        isActive && "bg-primary",
        hidden && "opacity-40",
        isDragging && "opacity-30",
        isDragOverlay && "bg-card border-border rounded-md border shadow-lg",
        wt.pending && "opacity-50",
        dropZone === "inside" && "ring-ring bg-primary/30 ring-2 ring-inset",
      )}
      title={wt.displayName ? `${worktreeName(wt)}\n${wt.path}` : wt.path}
      onClick={isRenaming ? undefined : onSelect}
      onContextMenu={onContextMenu}
      {...rootProps}
      {...(wt.pending || isDragOverlay ? undefined : sidebarEntryProps(wt.path))}
    >
      {(dropZone === "before" || dropZone === "after") && (
        <div
          className={cn(
            "bg-ring pointer-events-none absolute right-1 h-0.5 rounded-full",
            dropZone === "before" ? "top-0" : "bottom-0",
          )}
          style={{ left: `${indent}px` }}
        />
      )}
      {descendantCount > 0 && !isDragOverlay && (
        <button
          className="text-muted-foreground hover:text-foreground absolute cursor-pointer"
          style={{ left: `${indent - 18}px` }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapsed?.();
          }}
          // Keep the chevron from starting a drag of the row.
          onPointerDown={(e) => e.stopPropagation()}
          title={collapsed ? "Expand nested worktrees" : "Collapse nested worktrees"}
        >
          {collapsed ? (
            <ChevronRightIcon className="size-3.5" />
          ) : (
            <ChevronDownIcon className="size-3.5" />
          )}
        </button>
      )}
      <div className="relative shrink-0">
        <WorktreeIcon name={worktreeName(wt)} size="sm" />
        {hasNotification && !isActive && <NotificationDot />}
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">
        {isRenaming && onRenameFinish && onRenameCancel ? (
          <div className="flex">
            <InlineRenameInput
              currentName={label}
              onFinish={onRenameFinish}
              onCancel={onRenameCancel}
              className="text-foreground py-0.5"
            />
          </div>
        ) : (
          <div className="text-foreground truncate text-xs font-medium">{label}</div>
        )}
        <div className="text-muted-foreground truncate text-[10px]">
          {wt.pending === "creating"
            ? "Creating..."
            : wt.pending === "removing"
              ? "Removing..."
              : subtitle}
        </div>
      </div>
      {!isDragOverlay && (
        <button
          className={cn(
            "text-muted-foreground hover:text-foreground shrink-0 cursor-pointer transition-opacity",
            isOwnHidden ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
          onClick={(e) => {
            e.stopPropagation();
            onToggleVisibility?.();
          }}
          title={isOwnHidden ? "Show in collapsed view" : "Hide from collapsed view"}
        >
          {isOwnHidden ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
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
  onConfirm: (options: { deleteBranch: boolean; force: boolean; nested: NestedRemoval }) => void;
  onCancel: () => void;
}) {
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [force, setForce] = useState(false);
  const [nested, setNested] = useState<NestedRemoval>("move-up");
  const worktrees =
    useWorktreeStore((s) => s.byProject[plan.projectPath]?.worktrees) ?? EMPTY_WORKTREES;

  const nestedCount = plan.nested.length;
  const them = nestedCount === 1 ? "it" : "them";
  const removingNested = nested === "remove" && nestedCount > 0;
  const dirtyNested = removingNested ? plan.nested.filter((wt) => wt.dirty).length : 0;
  // Where "move up" puts the children: under the removed worktree's parent, or the top level.
  const parentPath = resolveParents(worktrees).get(plan.wtPath) ?? null;
  const parent = worktrees.find((wt) => wt.path === parentPath);

  const branch = plan.branch;
  const needsForce = plan.dirty || dirtyNested > 0;
  const blocked = needsForce && !force;
  const removeLabel = removingNested ? `Remove ${nestedCount + 1} worktrees` : "Remove worktree";
  const deleteOffered = branch !== null || removingNested;

  return (
    <DialogShell open onCancel={onCancel} className="w-96">
      <div className="px-4 pt-4 pb-2">
        <h3 className="text-foreground text-sm font-medium">Remove worktree</h3>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
          Delete worktree{" "}
          <span className="text-foreground font-medium break-words">{plan.name}</span>?
          {branch && (
            <>
              <br />
              Branch: <span className="text-foreground font-medium break-words">{branch}</span>
            </>
          )}
        </p>

        {plan.isMain && (
          <div className="border-warning/20 bg-warning/5 mt-3 rounded-md border p-2.5">
            <p className="text-warning text-[11px] font-medium">
              This is the repository&rsquo;s main worktree.
            </p>
          </div>
        )}

        {nestedCount > 0 && (
          <fieldset className="mt-3 flex flex-col gap-1.5">
            <legend className="text-muted-foreground mb-1.5 text-[11px]">
              {nestedCount === 1
                ? "1 worktree is nested below it."
                : `${nestedCount} worktrees are nested below it.`}
            </legend>
            <label className="text-muted-foreground flex items-center gap-2 text-[11px]">
              <input
                type="radio"
                name="nested-removal"
                checked={nested === "move-up"}
                onChange={() => setNested("move-up")}
                className="size-3"
              />
              {parent ? (
                <span>
                  Keep {them}, nested under{" "}
                  <span className="text-foreground font-medium">{worktreeLabel(parent)}</span>
                </span>
              ) : (
                `Keep ${them}, at the top level`
              )}
            </label>
            <label className="text-muted-foreground flex items-center gap-2 text-[11px]">
              <input
                type="radio"
                name="nested-removal"
                checked={nested === "remove"}
                onChange={() => setNested("remove")}
                className="accent-destructive size-3"
              />
              Remove {them} too
            </label>
          </fieldset>
        )}

        {(plan.dirty || dirtyNested > 0) && (
          <div className="border-warning/20 bg-warning/5 mt-3 rounded-md border p-2.5">
            <p className="text-warning text-[11px] font-medium">
              {plan.dirty && dirtyNested === 0
                ? "This worktree has uncommitted or untracked files. They will be lost."
                : "Some of these worktrees have uncommitted or untracked files. They will be lost."}
            </p>
          </div>
        )}

        <div className="mt-3 flex flex-col gap-1.5">
          {needsForce && (
            <label className="text-muted-foreground flex items-center gap-2 text-[11px]">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
                className="accent-destructive size-3"
              />
              Discard local changes (force remove)
            </label>
          )}
          {deleteOffered && (
            <label className="text-muted-foreground flex items-center gap-2 text-[11px]">
              <input
                type="checkbox"
                checked={deleteBranch}
                onChange={(e) => setDeleteBranch(e.target.checked)}
                className="accent-destructive size-3"
              />
              {removingNested ? (
                "Also delete their branches"
              ) : (
                <>Also delete branch &ldquo;{branch}&rdquo;</>
              )}
            </label>
          )}
        </div>

        {error && <div className="text-destructive mt-2 text-[10px]">{error}</div>}
      </div>

      <div className="flex flex-col gap-1.5 px-4 py-3">
        <Button
          variant="destructive-outline"
          size="xs"
          className="w-full"
          disabled={blocked}
          // A detached worktree's checkbox goes away when "Remove them too" is unpicked.
          onClick={() => onConfirm({ deleteBranch: deleteOffered && deleteBranch, force, nested })}
        >
          {deleteOffered && deleteBranch
            ? `${removeLabel} and ${removingNested ? "branches" : "branch"}`
            : removeLabel}
        </Button>
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
