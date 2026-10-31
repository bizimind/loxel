import { getJavaEnv } from "@/api/java-env-client";
import { javaToolchain } from "@/api/java-env-model";
import { javaEnvSourceDescription, javaRuntimeLabel, selectJavaRuntime } from "@/lib/java-runtime";
import { useActiveToolchainStatus } from "@/queries/use-toolchain-status";

import { ToolchainStatusButton } from "./ToolchainStatusButton";

/**
 * The JDK of the active editor's worktree, shown while that editor holds a Java file. Clicking it
 * opens the JDK picker for that worktree.
 */
export function JavaRuntimeStatus() {
  const active = useActiveToolchainStatus(javaToolchain, getJavaEnv);

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
    <ToolchainStatusButton
      label={env ? javaRuntimeLabel(env) : "No JDK found"}
      tooltip={tooltip}
      warning={!env || overrideUnusable}
      onSelect={() => void selectJavaRuntime(wtPath)}
    />
  );
}
