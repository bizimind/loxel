import { useQuery } from "@tanstack/react-query";
import * as monaco from "monaco-editor";
import { useEffect, useId, useMemo, useRef } from "react";

import * as api from "@/api/client";
import type { TypeScriptDiagnostic } from "@/api/diagnostics-model";
import type { FileDiff } from "@/api/diff-model";
import { fileDiffPath } from "@/api/diff-model";
import { type ServerId, type WorktreeRef, worktreeRef } from "@/api/worktree-ref";
import {
  computeFileDiff,
  splitGitLines,
  withoutCarriageReturns,
} from "@/components/diff/compute-file-diff";
import { EditableSideBanners } from "@/components/diff/EditableSideBanners";
import { SideBySideDiffView } from "@/components/diff/SideBySideDiffView";
import {
  REDIFF_DELAY_MS,
  editableDiffSideProps,
  useEditableSide,
  workingTreeSideKey,
} from "@/components/diff/use-editable-side";
import { PanelContext } from "@/components/dockview/panel-context";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { getDisplayFilename } from "@/lib/detached-path";
import { detectLanguage } from "@/lib/highlighter";
import { serverAuthority } from "@/lib/live-editor-model";
import { toMonacoLanguage } from "@/lib/monaco-theme";
import { hasTypeScriptDiagnostics } from "@/lib/typescript-files";
import { queryKeys } from "@/queries/query-keys";
import { useQueryScope } from "@/queries/use-scope";
import { type EditorKey, useEditorStateStore } from "@/store/editor-state";
import { getWorktreeUI } from "@/store/worktree-ui";

interface GitSideBySideDiffViewProps {
  file: FileDiff;
  oldRef: string | undefined;
  newRef: string | undefined;
  /** Worktree path for reading working tree files (uncommitted changes) */
  worktreePath?: string;
  /**
   * Called when the file on disk changes while its working-tree side is editable here, a save of
   * that side included
   */
  onWorkingTreeFileChange?: () => void;
}

/** Where one side of a git diff view comes from, and the view that shows it. */
export interface GitDiffSide {
  /** The diff's worktree (its repository's, for a diff of commits); null while none is known. */
  worktree: WorktreeRef | null;
  /** The file's path in the repository. */
  path: string;
  /**
   * The git ref it is read at (`HEAD` when none is given), or `working-tree` for the editable
   * working-tree file.
   */
  ref: string | undefined;
  side: "old" | "new";
  /** The mounted view showing it (its `useId`), which creates and disposes the model. */
  viewId: string;
}

/**
 * Model URI of one side of a git diff view:
 * `loxel://<serverId><worktree path>/<path>?<ref>#<view>-<side>`. The server and worktree keep the
 * same file of two worktrees or servers apart, the view keeps two views of one diff from sharing a
 * model that each disposes, and the side keeps both sides of a file apart. The query and fragment
 * keep it from being taken for an editor tab's live model of the file (see `editorFile`).
 */
export function gitDiffModelUri({ worktree, path, ref, side, viewId }: GitDiffSide): monaco.Uri {
  return monaco.Uri.from({
    scheme: "loxel",
    authority: worktree ? serverAuthority(worktree.server) : "",
    path: worktree ? `${worktree.path}/${path}` : `/${path}`,
    query: ref ?? "HEAD",
    fragment: `${viewId}-${side}`,
  });
}

/**
 * The side-by-side view of one file of a git diff: both versions, diagnostics and comments. In an
 * uncommitted diff the new side is the working-tree file itself, and is editable.
 */
export function GitSideBySideDiffView(props: GitSideBySideDiffViewProps) {
  const viewId = useId();
  const activeWorktreePath = useQueryScope().activeWorktree?.path ?? null;
  const { file, newRef, worktreePath } = props;
  const worktree = useDiffWorktree(worktreePath);
  const panelContext = useMemo(() => ({ worktree: worktree ?? null }), [worktree]);
  const absPath = worktreePath ? `${worktreePath}/${fileDiffPath(file)}` : null;
  // Open while the file is shown editable here, so a file deleted meanwhile stays editable, like
  // an editor tab: it keeps unsaved edits and offers to re-create the file.
  const sideOpen = useEditorStateStore(
    (s) =>
      worktree !== undefined &&
      absPath !== null &&
      s.files.has(workingTreeSideKey(worktree.server, absPath)),
  );
  // A deleted file has no working-tree file to edit. Files are read and saved through the active
  // worktree (the diff viewer's), so the uncommitted changes of another worktree stay read-only.
  const editable =
    !newRef && worktreePath === activeWorktreePath && (file.status !== "deleted" || sideOpen);
  if (!worktreePath || !worktree || !absPath || !editable)
    return <ReadOnlyGitDiffView {...props} viewId={viewId} />;

  return (
    // The diff viewer is a worktree's panel without a panel worktree of its own; the editable side
    // reads and saves its file through this one, as an editor tab of the worktree would.
    <PanelContext.Provider value={panelContext}>
      <WorkingTreeDiffView
        key={absPath}
        {...props}
        worktreePath={worktreePath}
        worktree={worktree}
        absPath={absPath}
        viewId={viewId}
      />
    </PanelContext.Provider>
  );
}

/**
 * The server a diff's files are read from. The diff source lives in the active worktree's
 * repository store and names a worktree of that repository by path, so the diff is the active
 * worktree's server's; a diff view without one has no files to read.
 */
function diffServer(activeWorktree: WorktreeRef | null): ServerId {
  if (!activeWorktree) throw new Error("A git diff is read from the active worktree's server");
  return activeWorktree.server;
}

/**
 * The ref of the diff's worktree, on the diff's server (see `diffServer`).
 */
function useDiffWorktree(worktreePath: string | undefined): WorktreeRef | undefined {
  const server = useQueryScope().activeWorktree?.server;
  return useMemo(
    () => (server && worktreePath ? worktreeRef(server, worktreePath) : undefined),
    [server, worktreePath],
  );
}

/** Both sides read from git, or the new side read from the working tree, neither editable. */
function ReadOnlyGitDiffView({
  file,
  oldRef,
  newRef,
  worktreePath,
  viewId,
}: GitSideBySideDiffViewProps & { viewId: string }) {
  const { activeProject, activeWorktree } = useQueryScope();
  const activeWorktreePath = activeWorktree?.path ?? null;
  const worktree = useDiffWorktree(worktreePath);

  const filePath = fileDiffPath(file);
  const oldPath = file.oldPath || file.newPath;

  const { lines: oldLines, isLoading: loadingOld } = useOldSideLines(file, oldRef, worktreePath);
  const { data: newFile, isLoading: loadingNew } = useQuery({
    queryKey: queryKeys.fileContent(activeProject, filePath, newRef, worktree),
    queryFn: () => {
      const server = diffServer(activeWorktree);
      // When viewing uncommitted changes, read new side from disk
      if (worktreePath && !newRef) {
        return api.getFileContent(server, { path: filePath, worktree: worktreePath });
      }
      return newRef
        ? api.getFileContent(server, {
            path: filePath,
            ref: newRef,
            wt: activeWorktreePath ?? undefined,
          })
        : Promise.resolve({ lines: [] });
    },
    enabled: file.status !== "deleted",
  });
  const newLines = newFile?.lines ?? EMPTY_LINES;

  const { oldDiagnostics, newDiagnostics } = useGitDiffDiagnostics(
    file,
    oldRef,
    newRef,
    worktreePath,
  );

  const language = useMemo(() => toMonacoLanguage(detectLanguage(filePath)), [filePath]);
  // A diff of commits names no worktree: it is of the active worktree's repository.
  const repo = worktree ?? activeWorktree;
  const oldModelUri = useMemo(
    () => gitDiffModelUri({ worktree: repo, path: oldPath, ref: oldRef, side: "old", viewId }),
    [repo, oldPath, oldRef, viewId],
  );
  const newModelUri = useMemo(
    () => gitDiffModelUri({ worktree: repo, path: filePath, ref: newRef, side: "new", viewId }),
    [repo, filePath, newRef, viewId],
  );

  return (
    <SideBySideDiffView
      hunks={file.hunks}
      isLoading={loadingOld || loadingNew}
      comments
      oldSide={{
        lines: oldLines,
        filePath: oldPath,
        language,
        modelUri: oldModelUri,
        diagnostics: oldDiagnostics,
        label: <OldSideLabel oldRef={oldRef} worktreePath={worktreePath} />,
      }}
      newSide={{
        lines: newLines,
        filePath,
        language,
        modelUri: newModelUri,
        diagnostics: newDiagnostics,
        label: (
          <>
            <span className="text-foreground ml-1">
              {worktreePath ? "Working Tree" : "Current"}
            </span>
            {!worktreePath && (
              <span className="text-muted-foreground font-mono">
                {" "}
                ({newRef?.slice(0, 7) ?? "..."})
              </span>
            )}
          </>
        ),
      }}
    />
  );
}

/**
 * An uncommitted diff whose new side is the working-tree file, editable and saved like an editor
 * tab. The hunks are computed here from the old side and the live text, so the diff follows every
 * edit instead of waiting for the save to come back as a new git diff.
 */
function WorkingTreeDiffView({
  file,
  oldRef,
  worktreePath,
  worktree,
  absPath,
  viewId,
  onWorkingTreeFileChange,
}: GitSideBySideDiffViewProps & {
  worktreePath: string;
  worktree: WorktreeRef;
  absPath: string;
  viewId: string;
}) {
  const filePath = fileDiffPath(file);
  const oldPath = file.oldPath || file.newPath;
  const editorKey = workingTreeSideKey(worktree.server, absPath);
  const side = useEditableSide(absPath, editorKey);

  // Lines are split as the server splits them (CRLF lines keep their "\r"), so comment anchors
  // made from them match the server's placement. The diff ignores the "\r": `git show` does not
  // convert line endings, so a file git checks out with CRLF has an LF old side.
  const { lines: oldLines, isLoading: loadingOld } = useOldSideLines(file, oldRef, worktreePath);
  const oldDiffLines = useMemo(() => withoutCarriageReturns(oldLines), [oldLines]);

  const newText = useDebouncedValue(side.text, REDIFF_DELAY_MS);
  const diff = useMemo(() => {
    if (newText === null || loadingOld) return null;
    const newLines = splitGitLines(newText);
    const { hunks } = computeFileDiff(oldDiffLines, withoutCarriageReturns(newLines));
    return { newLines, hunks };
  }, [newText, oldDiffLines, loadingOld]);

  useKeepEditedFileSelected(worktree, filePath, editorKey);

  // The diff refetch places comments once git sees the change; a save refetches them sooner.
  const onFileChangeRef = useRef(onWorkingTreeFileChange);
  onFileChangeRef.current = onWorkingTreeFileChange;
  const seenDiskTextRef = useRef<string | null>(null);
  useEffect(() => {
    if (side.diskText === null) return;
    const first = seenDiskTextRef.current === null;
    seenDiskTextRef.current = side.diskText;
    if (!first) onFileChangeRef.current?.();
  }, [side.diskText]);

  const { oldDiagnostics, newDiagnostics } = useGitDiffDiagnostics(
    file,
    oldRef,
    undefined,
    worktreePath,
  );

  const oldModelUri = useMemo(
    () => gitDiffModelUri({ worktree, path: oldPath, ref: oldRef, side: "old", viewId }),
    [worktree, oldPath, oldRef, viewId],
  );
  const newModelUri = useMemo(
    () => gitDiffModelUri({ worktree, path: filePath, ref: "working-tree", side: "new", viewId }),
    [worktree, filePath, viewId],
  );

  if (side.loadFailed) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
        Could not read {getDisplayFilename(absPath)}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <EditableSideBanners side={side} />
      <div className="flex-1 overflow-hidden">
        <SideBySideDiffView
          hunks={diff?.hunks ?? file.hunks}
          isLoading={!diff}
          comments
          keepExpandedOnChange
          oldSide={{
            lines: oldLines,
            filePath: oldPath,
            language: side.language,
            modelUri: oldModelUri,
            diagnostics: oldDiagnostics,
            label: <OldSideLabel oldRef={oldRef} worktreePath={worktreePath} />,
          }}
          newSide={{
            lines: diff?.newLines ?? EMPTY_LINES,
            filePath,
            language: side.language,
            modelUri: newModelUri,
            diagnostics: newDiagnostics,
            label: <span className="text-foreground ml-1">Working Tree</span>,
            ...editableDiffSideProps(side),
          }}
        />
      </div>
    </div>
  );
}

/**
 * Once the file is edited here, keep it selected and shown even if it leaves the diff (an edit can
 * make it match its base), until another file is selected or this view goes away.
 */
function useKeepEditedFileSelected(worktree: WorktreeRef, filePath: string, editorKey: EditorKey) {
  const isDirty = useEditorStateStore((s) => s.files.get(editorKey)?.state === "dirty");
  useEffect(() => {
    if (!isDirty) return;
    const ui = getWorktreeUI(worktree).getState();
    if (ui.selectedDiffFile === filePath) ui.setEditedDiffFile(filePath);
  }, [isDirty, worktree, filePath]);
  useEffect(
    () => () => {
      const ui = getWorktreeUI(worktree).getState();
      if (ui.editedDiffFile === filePath) ui.setEditedDiffFile(null);
    },
    [worktree, filePath],
  );
}

/** The old side of a git diff: the file at `oldRef` (none for an added file). */
function useOldSideLines(file: FileDiff, oldRef: string | undefined, worktreePath?: string) {
  const { activeProject, activeWorktree } = useQueryScope();
  const activeWorktreePath = activeWorktree?.path ?? null;
  const worktree = useDiffWorktree(worktreePath);
  const oldPath = file.oldPath || file.newPath;
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.fileContent(activeProject, oldPath, oldRef, worktree),
    queryFn: () =>
      oldRef
        ? api.getFileContent(diffServer(activeWorktree), {
            path: oldPath,
            ref: oldRef,
            wt: activeWorktreePath ?? undefined,
          })
        : Promise.resolve({ lines: [] }),
    enabled: file.status !== "added",
  });
  return { lines: file.status === "added" ? EMPTY_LINES : (data?.lines ?? EMPTY_LINES), isLoading };
}

/** TypeScript diagnostics of both sides, only for files tsc can report on. */
function useGitDiffDiagnostics(
  file: FileDiff,
  oldRef: string | undefined,
  newRef: string | undefined,
  worktreePath: string | undefined,
) {
  const { activeProject, activeWorktree } = useQueryScope();
  const activeWorktreePath = activeWorktree?.path ?? null;
  const worktree = useDiffWorktree(worktreePath);
  const filePath = fileDiffPath(file);
  const oldPath = file.oldPath || file.newPath;

  const { data: oldDiagData } = useQuery({
    queryKey: queryKeys.diagnostics(activeProject, oldRef, undefined),
    queryFn: () =>
      oldRef && activeWorktree
        ? api.getDiagnostics(activeWorktree, oldRef)
        : Promise.resolve({ diagnostics: [] }),
    enabled: !!oldRef && !!activeWorktreePath && hasTypeScriptDiagnostics(oldPath),
  });
  const { data: newDiagData } = useQuery({
    queryKey: queryKeys.diagnostics(activeProject, newRef, worktree),
    queryFn: () => {
      if (!activeWorktree) return Promise.resolve({ diagnostics: [] });
      if (worktreePath && !newRef)
        return api.getDiagnostics(activeWorktree, undefined, worktreePath);
      if (newRef) return api.getDiagnostics(activeWorktree, newRef);
      return Promise.resolve({ diagnostics: [] });
    },
    enabled: (!!newRef || !!worktreePath) && hasTypeScriptDiagnostics(filePath),
  });

  const oldDiagnostics = useMemo<TypeScriptDiagnostic[]>(
    () => oldDiagData?.diagnostics.filter((d) => d.file === oldPath) ?? EMPTY_DIAGNOSTICS,
    [oldDiagData, oldPath],
  );
  const newDiagnostics = useMemo<TypeScriptDiagnostic[]>(
    () => newDiagData?.diagnostics.filter((d) => d.file === filePath) ?? EMPTY_DIAGNOSTICS,
    [newDiagData, filePath],
  );
  return { oldDiagnostics, newDiagnostics };
}

function OldSideLabel({
  oldRef,
  worktreePath,
}: {
  oldRef: string | undefined;
  worktreePath: string | undefined;
}) {
  return (
    <>
      <span className="text-foreground ml-1">{worktreePath ? "HEAD" : "Parent"}</span>
      <span className="text-muted-foreground font-mono"> ({oldRef?.slice(0, 7) ?? "..."})</span>
    </>
  );
}

const EMPTY_LINES: string[] = [];
const EMPTY_DIAGNOSTICS: TypeScriptDiagnostic[] = [];
