import { useActiveEditorFile } from "@/hooks/useActiveEditorFilePath";
import { javaEnvSourceDescription, javaRuntimeLabel, selectJavaRuntime } from "@/lib/java-runtime";
import { resolveLanguage } from "@/lib/resolve-language";
import { cn } from "@/lib/utils";
import { useJavaEnvQuery } from "@/queries/use-repo-queries";
import { selectEffectiveFileAssociations, useSettingsStore } from "@/store/settings-store";

/**
 * The JDK of the active editor's worktree (the panel's own, which is not always the active
 * worktree), shown while that editor holds a Java file. Clicking it opens the JDK picker for that
 * worktree.
 */
export function JavaRuntimeStatus() {
  const active = useActiveEditorFile();
  const associations = useSettingsStore(selectEffectiveFileAssociations);
  const isJava = active !== null && resolveLanguage(active.filePath, associations) === "java";
  const wtPath = isJava ? active.worktreePath : null;
  const { data } = useJavaEnvQuery(wtPath);

  if (!wtPath || !data) return null;

  const { env, overridePath, ignoredJavaHome } = data;
  const overrideUnusable = overridePath !== null && env?.source !== "override";
  const tooltip = [
    env ? `${env.path}\n${javaEnvSourceDescription(env.source)}` : "No JDK found",
    overrideUnusable &&
      `The chosen JDK ${overridePath} cannot be used${env ? ", so detection picked this one" : ""}`,
    ignoredJavaHome && `JAVA_HOME (${ignoredJavaHome}) is not a usable JDK, so it was ignored`,
    "Click to select a JDK",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <button
      type="button"
      onClick={() => void selectJavaRuntime(wtPath)}
      title={tooltip}
      className={cn(
        "hover:text-foreground flex cursor-pointer items-center gap-1 transition-colors",
        env && !overrideUnusable ? "text-muted-foreground" : "text-warning",
      )}
    >
      {env ? javaRuntimeLabel(env) : "No JDK found"}
    </button>
  );
}
