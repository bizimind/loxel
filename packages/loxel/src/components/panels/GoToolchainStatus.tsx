import { getGoEnv } from "@/api/go-env-client";
import { GO_NOT_FOUND, type GoEnv, goToolchain } from "@/api/go-env-model";
import { refreshGoToolchain } from "@/lib/go-toolchain";
import { useActiveToolchainStatus } from "@/queries/use-toolchain-status";

import { ToolchainStatusButton } from "./ToolchainStatusButton";

const CHECK_AGAIN = "Click to check again";

function goTooltip(env: GoEnv | null): string {
  if (!env) return `${GO_NOT_FOUND}\nLoxel does not install Go\n${CHECK_AGAIN}`;
  const { newerGoNeeded: needed, newerToolchainSuggested: suggested } = env;
  return [
    env.binary,
    !env.version && "This go did not report its version",
    env.goroot && `GOROOT: ${env.goroot}`,
    env.gowork && `Workspace: ${env.gowork}`,
    env.gomod && `Module: ${env.gomod}`,
    !env.gowork && !env.gomod && "No go.mod or go.work at the worktree root",
    needed &&
      `${needed.file} needs Go ${needed.version}, and the Go on your PATH is ${env.version}. Loxel does not install Go: install Go ${needed.version}`,
    suggested &&
      `${suggested.file} suggests Go ${suggested.version}. Loxel does not download it and uses Go ${env.version}`,
    CHECK_AGAIN,
  ]
    .filter(Boolean)
    .join("\n");
}

function goLabel(env: GoEnv | null): string {
  if (!env) return "Go not found";
  return env.version ? `Go ${env.version}` : "Go";
}

/**
 * The Go toolchain of the active editor's worktree, shown while that editor holds a Go file.
 * Clicking it looks for Go again.
 */
export function GoToolchainStatus() {
  const active = useActiveToolchainStatus(goToolchain, getGoEnv);
  const env = active?.status.env;

  if (!active || env === undefined) return null;

  return (
    <ToolchainStatusButton
      label={goLabel(env)}
      tooltip={goTooltip(env)}
      warning={!env?.version || env.newerGoNeeded !== null}
      onSelect={() => void refreshGoToolchain(active.wtPath)}
    />
  );
}
