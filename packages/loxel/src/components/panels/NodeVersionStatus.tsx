import { getNodeEnv } from "@/api/node-env-client";
import { nodeToolchain } from "@/api/node-env-model";
import { nodeInstallLabel, nodeSourceDescription, selectNodeVersion } from "@/lib/node-version";
import { useActiveToolchainStatus } from "@/queries/use-toolchain-status";

import { ToolchainStatusButton } from "./ToolchainStatusButton";

/**
 * The Node of the active editor's worktree, shown while that editor holds a JavaScript or
 * TypeScript file. Clicking it opens the version picker for that worktree.
 */
export function NodeVersionStatus() {
  const active = useActiveToolchainStatus(nodeToolchain, getNodeEnv);

  if (!active) return null;

  const { wtPath, status } = active;
  const { env, pin, pinProblem, overridePath } = status;
  const overrideUnusable = overridePath !== null && env?.source !== "override";
  const tooltip = [
    env ? `${env.nodePath}\n${nodeSourceDescription(env, pin?.file ?? null)}` : "No Node found",
    pinProblem,
    overrideUnusable &&
      `The chosen Node ${overridePath} cannot be used, so detection picked this one`,
    "Click to select a Node version",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <ToolchainStatusButton
      label={env ? nodeInstallLabel(env) : "Select Node Version"}
      tooltip={tooltip}
      warning={!env || pinProblem !== null || overrideUnusable}
      onSelect={() => void selectNodeVersion(wtPath)}
    />
  );
}
