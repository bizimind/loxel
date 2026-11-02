import { skipToken, useQuery } from "@tanstack/react-query";

import { getJavaBuildFile, getJavaEnv } from "@/api/java-env-client";
import { javaToolchain } from "@/api/java-env-model";
import { useActiveEditorFile } from "@/hooks/useActiveEditorFilePath";
import { javaEnvSourceDescription, javaRuntimeLabel, selectJavaRuntime } from "@/lib/java-runtime";
import { useActiveToolchainStatus } from "@/queries/use-toolchain-status";

import { ToolchainStatusButton } from "./ToolchainStatusButton";

const PROJECT_NOT_LOADED_TOOLTIP =
  "Maven and Gradle projects aren't loaded yet. Syntax errors, completion and outlines work; type errors, rename and go-to-definition don't.";

/**
 * The JDK of the active editor's worktree, shown while that editor holds a Java file. Clicking it
 * opens the JDK picker for that worktree. Next to it, a note when the file belongs to a Maven or
 * Gradle project.
 */
export function JavaRuntimeStatus() {
  const active = useActiveToolchainStatus(javaToolchain, getJavaEnv);
  const filePath = useActiveEditorFile()?.filePath ?? null;
  const worktreePath = active?.wtPath ?? null;
  const { data: buildFile } = useQuery({
    queryKey: ["java-build-file", worktreePath, filePath],
    queryFn:
      worktreePath && filePath ? () => getJavaBuildFile({ worktreePath, filePath }) : skipToken,
  });

  if (!active) return null;

  const { wtPath, status } = active;
  const { env, overridePath, ignoredJavaHome } = status;
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
      {buildFile?.buildTool && (
        <span className="text-muted-foreground" title={PROJECT_NOT_LOADED_TOOLTIP}>
          {buildFile.buildTool} project not loaded yet
        </span>
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
