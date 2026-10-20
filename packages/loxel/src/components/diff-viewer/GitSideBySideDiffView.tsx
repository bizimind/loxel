import { useQuery } from "@tanstack/react-query";
import * as monaco from "monaco-editor";
import { useMemo } from "react";

import * as api from "@/api/client";
import type { TypeScriptDiagnostic } from "@/api/diagnostics-model";
import type { FileDiff } from "@/api/diff-model";
import { fileDiffPath } from "@/api/diff-model";
import { SideBySideDiffView } from "@/components/diff/SideBySideDiffView";
import { detectLanguage } from "@/lib/highlighter";
import { toMonacoLanguage } from "@/lib/monaco-theme";
import { queryKeys } from "@/queries/query-keys";
import { useQueryScope } from "@/queries/use-scope";

interface GitSideBySideDiffViewProps {
  file: FileDiff;
  oldRef: string | undefined;
  newRef: string | undefined;
  /** Worktree path for reading working tree files (uncommitted changes) */
  worktreePath?: string;
}

/**
 * Read-only model of a file at a git ref (HEAD for the working tree) on one side of a diff.
 * The fragment keeps the two sides apart when they show the same file and ref.
 */
function gitDiffModelUri(path: string, ref: string | undefined, side: "old" | "new") {
  return monaco.Uri.from({
    scheme: "loxel",
    authority: ref ?? "HEAD",
    path: `/${path}`,
    fragment: side,
  });
}

/** The side-by-side view of one file of a git diff: both versions, diagnostics and comments. */
export function GitSideBySideDiffView({
  file,
  oldRef,
  newRef,
  worktreePath,
}: GitSideBySideDiffViewProps) {
  const { activeProjectPath, activeWorktreePath } = useQueryScope();

  // Fetch full file content for both versions
  const filePath = fileDiffPath(file);
  const oldPath = file.oldPath || file.newPath;

  const { data: oldFile, isLoading: loadingOld } = useQuery({
    queryKey: queryKeys.fileContent(activeProjectPath, oldPath, oldRef, worktreePath),
    queryFn: () =>
      oldRef
        ? api.getFileContent({ path: oldPath, ref: oldRef, wt: activeWorktreePath ?? undefined })
        : Promise.resolve({ lines: [] }),
    enabled: file.status !== "added",
  });

  const { data: newFile, isLoading: loadingNew } = useQuery({
    queryKey: queryKeys.fileContent(activeProjectPath, filePath, newRef, worktreePath),
    queryFn: () => {
      // When viewing uncommitted changes, read new side from disk
      if (worktreePath && !newRef) {
        return api.getFileContent({ path: filePath, worktree: worktreePath });
      }
      return newRef
        ? api.getFileContent({ path: filePath, ref: newRef, wt: activeWorktreePath ?? undefined })
        : Promise.resolve({ lines: [] });
    },
    enabled: file.status !== "deleted",
  });

  const oldLines = oldFile?.lines ?? EMPTY_LINES;
  const newLines = newFile?.lines ?? EMPTY_LINES;

  // Fetch TypeScript diagnostics for both refs
  const { data: oldDiagData } = useQuery({
    queryKey: queryKeys.diagnostics(activeProjectPath, oldRef, undefined),
    queryFn: () =>
      oldRef && activeWorktreePath
        ? api.getDiagnostics(activeWorktreePath, oldRef)
        : Promise.resolve({ diagnostics: [] }),
    enabled: !!oldRef && !!activeWorktreePath,
  });
  const { data: newDiagData } = useQuery({
    queryKey: queryKeys.diagnostics(activeProjectPath, newRef, worktreePath),
    queryFn: () => {
      if (!activeWorktreePath) return Promise.resolve({ diagnostics: [] });
      if (worktreePath && !newRef)
        return api.getDiagnostics(activeWorktreePath, undefined, worktreePath);
      if (newRef) return api.getDiagnostics(activeWorktreePath, newRef);
      return Promise.resolve({ diagnostics: [] });
    },
    enabled: !!newRef || !!worktreePath,
  });

  // Filter diagnostics to this file
  const oldDiagnostics = useMemo<TypeScriptDiagnostic[]>(() => {
    if (!oldDiagData?.diagnostics) return [];
    return oldDiagData.diagnostics.filter((d) => d.file === oldPath);
  }, [oldDiagData, oldPath]);

  const newDiagnostics = useMemo<TypeScriptDiagnostic[]>(() => {
    if (!newDiagData?.diagnostics) return [];
    return newDiagData.diagnostics.filter((d) => d.file === filePath);
  }, [newDiagData, filePath]);

  const language = useMemo(() => toMonacoLanguage(detectLanguage(filePath)), [filePath]);
  const oldModelUri = useMemo(() => gitDiffModelUri(oldPath, oldRef, "old"), [oldPath, oldRef]);
  const newModelUri = useMemo(() => gitDiffModelUri(filePath, newRef, "new"), [filePath, newRef]);

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
        label: (
          <>
            <span className="text-foreground ml-1">{worktreePath ? "HEAD" : "Parent"}</span>
            <span className="text-muted-foreground font-mono">
              {" "}
              ({oldRef?.slice(0, 7) ?? "..."})
            </span>
          </>
        ),
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

const EMPTY_LINES: string[] = [];
