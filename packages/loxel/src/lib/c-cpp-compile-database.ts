import {
  getCompileDatabaseStatus,
  setCompileDatabaseChoice,
} from "@/api/c-cpp-compile-database-client";
import {
  cCppToolchain,
  type CompileDatabaseFileResponse,
  type CompileDatabaseStatus,
} from "@/api/c-cpp-compile-database-model";
import { showToast } from "@/components/ui/toast";
import { queryKeys } from "@/queries/query-keys";
import { queryClient } from "@/query-client";
import { type QuickPickItem, requestQuickPick, requestTextInput } from "@/store/command-palette";
import { deriveProject, useProjectStore } from "@/store/projects";

import { abbreviateHomePath } from "./home-path";

// Picker ids that cannot collide with a folder, which is always absolute.
const ENTER_PATH_ID = "#enter-path";
const AUTOMATIC_ID = "#automatic";

const LANGUAGE_NAMES: Record<string, string> = {
  c: "C",
  cpp: "C++",
  "objective-c": "Objective-C",
  "objective-cpp": "Objective-C++",
};

function baseName(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf("/") + 1);
}

function parentOf(filePath: string): string {
  return filePath.slice(0, filePath.lastIndexOf("/"));
}

/** A folder as the picker and status item name it: under the worktree, or by its own name. */
export function compileDatabaseFolderName(wtPath: string, folder: string): string {
  if (folder === wtPath) return baseName(wtPath);
  return folder.startsWith(`${wtPath}/`) ? folder.slice(wtPath.length + 1) : baseName(folder);
}

/** A database as the status item names it: its folder, or the file when the folder says nothing. */
function databaseName(wtPath: string, database: string): string {
  const folder = parentOf(database);
  const isFlagsFile = baseName(database) === "compile_flags.txt";
  if (folder === wtPath) return baseName(database);
  const name = compileDatabaseFolderName(wtPath, folder);
  return isFlagsFile ? `${name}/${baseName(database)}` : name;
}

/** The status item's text and whether it warns, for the active file. */
export function compileDatabaseSummary(
  languageId: string,
  wtPath: string,
  status: CompileDatabaseStatus,
  file: CompileDatabaseFileResponse,
): { label: string; warning: boolean } {
  const language = LANGUAGE_NAMES[languageId] ?? "C/C++";
  const chosenUnusable = status.chosen !== null && !status.chosenUsable;
  const name = (text: string, warning: boolean) => ({
    label: `${language} (${text})`,
    warning: warning || chosenUnusable,
  });
  if (file.database) return name(databaseName(wtPath, file.database.path), false);
  // The project turned it off itself, so there is nothing to warn about or to choose between.
  if (file.clangdConfig?.effect === "none") return name("no compile database", false);
  if (status.candidates.length > 0) return name("choose a compile database", true);
  if (file.clangdConfig?.effect === "flags") return name(".clangd flags", false);
  return name("no compile database", true);
}

const SOURCE_DESCRIPTIONS = {
  chosen: "Chosen for this worktree. clangd uses it for every file.",
  automatic:
    "Found automatically, as the only one in a non-standard build folder. clangd uses it for every file.",
  search: "Found by clangd, looking upward from this file's folder.",
  "clangd-config": "Named by CompilationDatabase in a .clangd file.",
} as const;

const CLANGD_CONFIG_DESCRIPTIONS = {
  none: "turns the compile database off",
  missing: "names a folder with no compile database",
  flags: "adds compile flags; clangd guesses the rest",
} as const;

/** The status item's tooltip: which database, how it was found, and otherwise what to do. */
export function compileDatabaseTooltip(
  wtPath: string,
  status: CompileDatabaseStatus,
  file: CompileDatabaseFileResponse,
): string {
  const { database, clangdConfig, hint } = file;
  const candidateNames = status.candidates.map((c) => compileDatabaseFolderName(wtPath, c));
  const lines = [
    database && `${database.path}\n${SOURCE_DESCRIPTIONS[database.source]}`,
    !database && "clangd is guessing this file's compile flags, so includes may be missing.",
    clangdConfig && `${clangdConfig.path} ${CLANGD_CONFIG_DESCRIPTIONS[clangdConfig.effect]}.`,
    status.chosen !== null &&
      !status.chosenUsable &&
      `The chosen folder ${status.chosen} has no compile database.`,
    !database && candidateNames.length > 0 && `Found in: ${candidateNames.join(", ")}.`,
    !database &&
      candidateNames.length === 1 &&
      status.foundByClangd.length > 0 &&
      "Not used by itself: it would apply to every file, including those with a compile database of their own.",
    !database &&
      candidateNames.length === 1 &&
      status.searchCut &&
      "Not used by itself: this worktree is too large to check that no file has its own.",
    !database && candidateNames.length > 1 && "Which one applies is your choice.",
    clangdConfig?.effect !== "none" && hint,
    "Click to select a compile database",
  ];
  return lines.filter(Boolean).join("\n");
}

export function automaticDescription(status: CompileDatabaseStatus, wtPath: string): string {
  if (status.automatic) return compileDatabaseFolderName(wtPath, status.automatic);
  if (status.foundByClangd.length > 0) return "clangd finds each file's own";
  if (status.searchCut) return "Worktree too large to check; none picked";
  return status.candidates.length > 0 ? "Several found; none picked" : "None found";
}

/**
 * Let the user choose worktree `wtPath`'s compile database in the command palette: one found, a path
 * they enter, or automatic detection. The choice is saved per worktree on the server, and clangd
 * restarts with it.
 */
export async function selectCompileDatabase(wtPath: string): Promise<void> {
  const { homeDir } = useProjectStore.getState();
  const state = getCompileDatabaseStatus(wtPath);
  const items = state.then((status) => {
    const list: QuickPickItem[] = [
      { id: ENTER_PATH_ID, label: "Enter a folder or compile database path…" },
      {
        id: AUTOMATIC_ID,
        label: "Use automatic detection",
        description: automaticDescription(status, wtPath),
        current: status.chosen === null,
      },
      ...status.candidates.map((folder) => ({
        id: folder,
        label: compileDatabaseFolderName(wtPath, folder),
        description: abbreviateHomePath(folder, homeDir),
        current: folder === status.chosen,
      })),
    ];
    return list;
  });

  const picked = await requestQuickPick({ placeholder: "Select a compile database", items });
  if (picked === null) return;

  let chosen: string | null = picked === AUTOMATIC_ID ? null : picked;
  if (picked === ENTER_PATH_ID) {
    const { chosen: current } = await state;
    chosen = await requestTextInput({
      placeholder: "Path of a folder holding compile_commands.json or compile_flags.txt",
      value: current ?? "",
    });
    if (chosen === null) return;
  }

  try {
    await setCompileDatabaseChoice({ worktreePath: wtPath, path: chosen });
    // The status and each file's answer, whose keys extend it.
    const projectPath = deriveProject(wtPath, useProjectStore.getState().projects)?.path ?? null;
    await queryClient.invalidateQueries({
      queryKey: queryKeys.toolchainStatus(cCppToolchain.id, projectPath, wtPath),
    });
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Could not set the compile database");
  }
}
