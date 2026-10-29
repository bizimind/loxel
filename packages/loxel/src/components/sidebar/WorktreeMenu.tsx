/**
 * The worktree context menu (copy, open in, nesting, archive, remove) and the dialogs it opens,
 * shared by every worktree row in the sidebar.
 */
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowUpToLineIcon,
  CopyIcon,
  FolderIcon,
  GitBranchIcon,
  GitBranchPlusIcon,
  ListTreeIcon,
  PencilIcon,
  TrashIcon,
} from "lucide-react";
import { useCallback, useState } from "react";

import type { WorktreeEntry } from "@/api/git-models";
import type { NestedRemoval } from "@/api/worktree-removal-model";
import { OpenInMenuItems, isOpenInSupported } from "@/components/menus/OpenInMenuItems";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { DialogShell } from "@/components/ui/dialog-shell";
import { copyToClipboard } from "@/lib/clipboard";
import { archivedSet, resolveParents } from "@/lib/worktree-hierarchy";
import { useWorktreeStore } from "@/store/worktrees";

import { EnableNestingDialog } from "./EnableNestingDialog";
import { worktreeLabel, worktreeName } from "./worktree-labels";

const EMPTY_WORKTREES: WorktreeEntry[] = [];

export function useWorktreeContextMenu(projectPath: string) {
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
 * Renders the worktree context menu (copy, nesting, archive, remove) + removal dialogs.
 * `onNewChild` and `onRename` need the expanded list's inline inputs; without them the items
 * are left out.
 */
export function WorktreeContextMenu({
  menu,
  onNewChild,
  onRename,
}: {
  menu: ReturnType<typeof useWorktreeContextMenu>;
  onNewChild?: (wt: WorktreeEntry) => void;
  onRename?: (wt: WorktreeEntry) => void;
}) {
  const toggleArchived = useWorktreeStore((s) => s.toggleArchived);
  const markArchived = useWorktreeStore((s) => s.markArchived);
  const wt = menu.contextMenu?.worktree;
  const isArchived = useWorktreeStore((s) => {
    const ps = s.byProject[menu.projectPath];
    return (
      wt !== undefined &&
      ps !== undefined &&
      archivedSet(ps.worktrees, ps.archivedPaths ?? []).has(wt.path)
    );
  });
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
                <ContextMenuItem
                  onClick={() => {
                    // Archived with its parent, it stays archived at the Archive's top level.
                    if (isArchived) markArchived(menu.projectPath, wt.path);
                    void menu.handleSetParent(wt.path, null);
                  }}
                >
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
          <ContextMenuItem onClick={() => toggleArchived(menu.projectPath, wt.path)}>
            {isArchived ? (
              <ArchiveRestoreIcon className="size-3.5" />
            ) : (
              <ArchiveIcon className="size-3.5" />
            )}
            {isArchived ? "Unarchive worktree" : "Archive worktree"}
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
