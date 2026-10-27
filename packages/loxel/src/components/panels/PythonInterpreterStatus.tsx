import { useActiveEditorFile } from "@/hooks/useActiveEditorFilePath";
import {
  pythonEnvSourceDescription,
  pythonInterpreterLabel,
  selectPythonInterpreter,
} from "@/lib/python-interpreter";
import { resolveLanguage } from "@/lib/resolve-language";
import { cn } from "@/lib/utils";
import { usePythonEnvQuery } from "@/queries/use-repo-queries";
import { selectEffectiveFileAssociations, useSettingsStore } from "@/store/settings-store";

/**
 * The Python interpreter of the active editor's worktree (the panel's own, which is not always the
 * active worktree), shown while that editor holds a Python file. Clicking it opens the
 * interpreter picker for that worktree.
 */
export function PythonInterpreterStatus() {
  const active = useActiveEditorFile();
  const associations = useSettingsStore(selectEffectiveFileAssociations);
  const isPython = active !== null && resolveLanguage(active.filePath, associations) === "python";
  const wtPath = isPython ? active.worktreePath : null;
  const { data } = usePythonEnvQuery(wtPath);

  if (!wtPath || !data) return null;

  const { env, overridePath } = data;
  const overrideUnusable = overridePath !== null && env?.source !== "override";
  const label = env ? pythonInterpreterLabel(env, wtPath) : "Select Python Interpreter";
  const tooltip = [
    env
      ? `${env.pythonPath}\n${pythonEnvSourceDescription(env.source)}`
      : "No Python interpreter found",
    overrideUnusable &&
      `The chosen interpreter ${overridePath} cannot be used, so detection picked this one`,
    "Click to select an interpreter",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <button
      type="button"
      onClick={() => void selectPythonInterpreter(wtPath)}
      title={tooltip}
      className={cn(
        "hover:text-foreground flex cursor-pointer items-center gap-1 transition-colors",
        env && !overrideUnusable ? "text-muted-foreground" : "text-warning",
      )}
    >
      {label}
    </button>
  );
}
