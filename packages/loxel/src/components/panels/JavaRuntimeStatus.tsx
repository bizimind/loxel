import { getJavaEnv, reloadJavaProjects } from "@/api/java-env-client";
import { javaToolchain } from "@/api/java-env-model";
import { useActiveEditorFile } from "@/hooks/useActiveEditorFilePath";
import { javaEnvSourceDescription, javaRuntimeLabel, selectJavaRuntime } from "@/lib/java-runtime";
import { resolveLanguage } from "@/lib/resolve-language";
import { useActiveToolchainStatus } from "@/queries/use-toolchain-status";
import { selectEffectiveFileAssociations, useSettingsStore } from "@/store/settings-store";

import { ToolchainStatusButton } from "./ToolchainStatusButton";

/**
 * The JDK of the active editor's worktree, shown while that editor holds a Java file. Clicking it
 * opens the JDK picker for that worktree. Next to it, a note when a trusted repository's Maven or
 * Gradle projects did not fully load, which loads them again when clicked.
 */
export function JavaRuntimeStatus() {
  const active = useActiveToolchainStatus(javaToolchain, getJavaEnv);
  const filePath = useActiveEditorFile()?.filePath;
  const associations = useSettingsStore(selectEffectiveFileAssociations);
  const inJavaFile = filePath !== undefined && resolveLanguage(filePath, associations) === "java";

  if (!active) return null;

  const { wtPath, status } = active;
  const { env, overridePath, ignoredJavaHome, projectIssue } = status;
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
    <>
      {projectIssue && inJavaFile && (
        <button
          type="button"
          className="text-warning hover:text-foreground cursor-pointer transition-colors"
          title={projectIssue.detail}
          onClick={() => void reloadJavaProjects({ worktreePath: wtPath })}
        >
          {projectIssue.label}
        </button>
      )}
      <ToolchainStatusButton
        label={env ? javaRuntimeLabel(env) : "No JDK found"}
        tooltip={tooltip}
        warning={!env || overrideUnusable}
        onSelect={() => void selectJavaRuntime(wtPath)}
      />
    </>
  );
}
