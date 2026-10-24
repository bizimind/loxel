import * as api from "@/api/client";
import type { PythonEnv, PythonEnvSource, PythonInterpreter } from "@/api/python-env-model";
import { showToast } from "@/components/ui/toast";
import { queryKeys } from "@/queries/query-keys";
import { getQueryScope } from "@/queries/use-scope";
import { queryClient } from "@/query-client";
import { type QuickPickItem, requestQuickPick, requestTextInput } from "@/store/command-palette";
import { useProjectStore } from "@/store/projects";

import { abbreviateHomePath } from "./home-path";

// Picker ids that cannot collide with an interpreter path, which is always absolute.
const ENTER_PATH_ID = "#enter-path";
const AUTOMATIC_ID = "#automatic";

const SOURCE_DESCRIPTIONS: Record<PythonEnvSource, string> = {
  override: "Chosen for this worktree",
  "virtual-env": "Detected from VIRTUAL_ENV",
  venv: "Detected virtual environment",
  pixi: "Detected Pixi environment",
  poetry: "Detected Poetry environment",
  system: "Detected on the login-shell PATH",
};

/**
 * A short name for the environment: its path relative to the worktree (`.venv`, `api/.venv`),
 * its directory name when it lies elsewhere (Poetry's cache), or `global` outside any environment.
 */
export function pythonEnvName(env: PythonEnv, wtPath: string): string {
  if (!env.envPath) return "global";
  const root = wtPath.endsWith("/") ? wtPath : `${wtPath}/`;
  if (env.envPath.startsWith(root)) return env.envPath.slice(root.length);
  return env.envPath.split("/").findLast(Boolean) ?? env.envPath;
}

/** An interpreter path for display: `./`-relative inside the worktree, else `~`-abbreviated. */
export function displayPythonPath(
  pythonPath: string,
  wtPath: string,
  homeDir: string | null,
): string {
  const root = wtPath.endsWith("/") ? wtPath : `${wtPath}/`;
  if (pythonPath.startsWith(root)) return `./${pythonPath.slice(root.length)}`;
  return abbreviateHomePath(pythonPath, homeDir);
}

/** The interpreter as shown in the status bar and picker, e.g. `Python 3.12.13 (.venv)`. */
export function pythonInterpreterLabel(env: PythonInterpreter, wtPath: string): string {
  const version = env.version ? `Python ${env.version}` : "Python";
  return `${version} (${pythonEnvName(env, wtPath)})`;
}

/** Where the interpreter came from, for tooltips. */
export function pythonEnvSourceDescription(source: PythonEnvSource): string {
  return SOURCE_DESCRIPTIONS[source];
}

/**
 * Let the user choose the active worktree's Python interpreter in the command palette: a
 * discovered environment, a path they enter, or automatic detection. The choice is saved per
 * worktree on the server, which hands it to the language server and everything else that
 * resolves the worktree's Python.
 */
export async function selectPythonInterpreter(): Promise<void> {
  const { activeProjectPath, activeWorktreePath: wtPath } = getQueryScope();
  if (!wtPath) return;

  const { homeDir } = useProjectStore.getState();
  const state = Promise.all([api.getPythonEnvCandidates(wtPath), api.getPythonEnv(wtPath)]);
  const items = state.then(([{ candidates, automaticPath }, { env, overridePath }]) => {
    const automatic = candidates.find((c) => c.pythonPath === automaticPath);
    const choices = [...candidates];
    // An entered interpreter is not among the discovered ones; list it so it shows as current.
    if (env?.source === "override" && !choices.some((c) => c.pythonPath === env.pythonPath)) {
      choices.unshift(env);
    }
    const list: QuickPickItem[] = [
      { id: ENTER_PATH_ID, label: "Enter interpreter path…" },
      {
        id: AUTOMATIC_ID,
        label: "Use automatic detection",
        description: automatic ? pythonInterpreterLabel(automatic, wtPath) : "No interpreter found",
        current: overridePath === null,
      },
      ...choices.map((c) => ({
        id: c.pythonPath,
        label: pythonInterpreterLabel(c, wtPath),
        description: displayPythonPath(c.pythonPath, wtPath, homeDir),
        current: c.pythonPath === overridePath,
      })),
    ];
    return list;
  });

  const picked = await requestQuickPick({ placeholder: "Select a Python interpreter", items });
  if (picked === null) return;

  let pythonPath: string | null = picked === AUTOMATIC_ID ? null : picked;
  if (picked === ENTER_PATH_ID) {
    const [, { overridePath }] = await state;
    pythonPath = await requestTextInput({
      placeholder: "Path to a Python interpreter or environment directory",
      value: overridePath ?? "",
    });
    if (pythonPath === null) return;
  }

  try {
    const response = await api.setPythonOverride({ worktreePath: wtPath, pythonPath });
    queryClient.setQueryData(queryKeys.pythonEnv(activeProjectPath, wtPath), response);
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Could not set the Python interpreter");
  }
}
