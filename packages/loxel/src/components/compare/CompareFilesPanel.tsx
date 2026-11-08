import * as monaco from "monaco-editor";
import { useCallback, useMemo } from "react";

import type { FileDiff } from "@/api/diff-model";
import { DiffToolbar } from "@/components/diff-viewer/DiffToolbar";
import { FileDiffHeader } from "@/components/diff-viewer/FileDiffHeader";
import { HunkBasedDiffView } from "@/components/diff-viewer/HunkBasedDiffView";
import { computeFileDiff, splitLines } from "@/components/diff/compute-file-diff";
import { EditableSideBanners } from "@/components/diff/EditableSideBanners";
import { type DiffSide, SideBySideDiffView } from "@/components/diff/SideBySideDiffView";
import {
  type EditableSide,
  REDIFF_DELAY_MS,
  editableDiffSideProps,
  editableSideKey,
  useEditableSide,
} from "@/components/diff/use-editable-side";
import { usePanelWorktreePath } from "@/components/dockview/panel-context";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { getDisplayFilename } from "@/lib/detached-path";
import { relativeTo } from "@/lib/project-file-helpers";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/store/ui";

interface CompareFilesPanelProps {
  /** Dockview panel id; keys this panel's editor-state entries and Monaco models */
  panelId: string;
  /** Absolute path of the left (old) file */
  oldPath: string;
  /** Absolute path of the right (new) file */
  newPath: string;
}

/**
 * Two files compared in the diff viewer: the same toolbar, side-by-side and unified views as a
 * git diff, with both sides editable and saved like editor tabs. The diff is recomputed on the
 * client whenever either side's text changes, by an edit here or a change on disk.
 */
export function CompareFilesPanel({ panelId, oldPath, newPath }: CompareFilesPanelProps) {
  const viewMode = useUIStore((s) => s.diffViewMode);
  const worktreePath = usePanelWorktreePath();
  const oldSide = useEditableSide(oldPath, editableSideKey(panelId, "old"));
  const newSide = useEditableSide(newPath, editableSideKey(panelId, "new"));

  const oldText = useDebouncedValue(oldSide.text, REDIFF_DELAY_MS);
  const newText = useDebouncedValue(newSide.text, REDIFF_DELAY_MS);
  const diff = useMemo(() => {
    if (oldText === null || newText === null) return null;
    const oldLines = splitLines(oldText);
    const newLines = splitLines(newText);
    return { oldLines, newLines, ...computeFileDiff(oldLines, newLines) };
  }, [oldText, newText]);

  const file = useMemo<FileDiff | null>(
    () =>
      diff && {
        oldPath,
        newPath,
        status: "modified",
        hunks: diff.hunks,
        isBinary: false,
        additions: diff.additions,
        deletions: diff.deletions,
      },
    [diff, oldPath, newPath],
  );

  const newLines = diff?.newLines;
  const loadContextLines = useCallback(
    async (startLine: number, endLine: number) => newLines?.slice(startLine - 1, endLine) ?? [],
    [newLines],
  );

  const oldModelUri = useMemo(() => compareModelUri(oldPath, panelId, "old"), [oldPath, panelId]);
  const newModelUri = useMemo(() => compareModelUri(newPath, panelId, "new"), [newPath, panelId]);

  const oldLabel = displayPath(oldPath, worktreePath);
  const newLabel = displayPath(newPath, worktreePath);
  const failed = [oldSide, newSide].filter((side) => side.loadFailed);

  const body = (() => {
    if (failed.length > 0) {
      return (
        <Placeholder>
          Could not read {failed.map((side) => getDisplayFilename(side.filePath)).join(" or ")}
        </Placeholder>
      );
    }
    if (!diff || !file) return <Placeholder>Loading files...</Placeholder>;

    const title = (
      <>
        {getDisplayFilename(oldPath)} ↔ {getDisplayFilename(newPath)}
        {diff.hunks.length === 0 && (
          <span className="text-muted-foreground ml-2 font-normal">Files are identical</span>
        )}
      </>
    );

    if (viewMode === "unified") {
      return (
        <HunkBasedDiffView
          file={file}
          viewMode="unified"
          loadContextLines={loadContextLines}
          title={title}
        />
      );
    }
    return (
      <div className="flex h-full flex-col">
        <FileDiffHeader file={file} title={title} />
        <div className="flex-1 overflow-hidden">
          <SideBySideDiffView
            hunks={diff.hunks}
            keepExpandedOnChange
            oldSide={toDiffSide(oldSide, diff.oldLines, oldModelUri, oldLabel)}
            newSide={toDiffSide(newSide, diff.newLines, newModelUri, newLabel)}
          />
        </div>
      </div>
    );
  })();

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <EditableSideBanners side={oldSide} />
      <EditableSideBanners side={newSide} />
      <div className="bg-editor-surface flex flex-1 scrollbar-thin flex-col overflow-hidden font-mono text-xs">
        <DiffToolbar />
        <div
          className={cn(
            "flex-1",
            viewMode === "split" ? "overflow-hidden" : "scrollbar-thin overflow-auto",
          )}
        >
          {body}
        </div>
      </div>
    </div>
  );
}

/**
 * Model URI of a compare side. Unique per panel and side, since each side's model is disposed
 * with its editor, and outside `loxel://HEAD` so it is not taken for an editor tab's live model.
 */
function compareModelUri(filePath: string, panelId: string, side: "old" | "new") {
  return monaco.Uri.from({
    scheme: "loxel",
    authority: "compare",
    path: filePath,
    fragment: `${panelId}-${side}`,
  });
}

/** A path relative to the panel's worktree when inside it, absolute otherwise. */
function displayPath(filePath: string, worktreePath: string | null): string {
  return (worktreePath && relativeTo(filePath, worktreePath)) || filePath;
}

function toDiffSide(
  side: EditableSide,
  lines: string[],
  modelUri: monaco.Uri,
  label: string,
): DiffSide {
  return {
    lines,
    filePath: side.filePath,
    language: side.language,
    modelUri,
    label: (
      <span className="text-foreground ml-1" title={side.filePath}>
        {label}
      </span>
    ),
    ...editableDiffSideProps(side),
  };
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
      {children}
    </div>
  );
}
