import { useActionHandler } from "@/hooks/useActionHandler";
import { useActiveEditorFilePath } from "@/hooks/useActiveEditorFilePath";
import { pythonEnvSourceDescription, pythonInterpreterLabel } from "@/lib/python-interpreter";
import { resolveLanguage } from "@/lib/resolve-language";
import { cn } from "@/lib/utils";
import { usePythonEnvQuery } from "@/queries/use-repo-queries";
import { selectEffectiveFileAssociations, useSettingsStore } from "@/store/settings-store";
import { useWorktreeStore } from "@/store/worktrees";

/**
 * The active worktree's Python interpreter, shown while a Python file is the active editor.
 * Clicking it opens the interpreter picker.
 */
export function PythonInterpreterStatus() {
  const filePath = useActiveEditorFilePath();
  const associations = useSettingsStore(selectEffectiveFileAssociations);
  const isPython = filePath !== null && resolveLanguage(filePath, associations) === "python";
  const wtPath = useWorktreeStore((s) => s.activeWorktreePath);
  const { data } = usePythonEnvQuery(isPython);
  const dispatch = useActionHandler();

  if (!isPython || !data || !wtPath) return null;

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
      onClick={() => dispatch("python.selectInterpreter")}
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
