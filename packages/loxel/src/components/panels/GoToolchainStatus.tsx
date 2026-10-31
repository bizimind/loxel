import { getGoEnv } from "@/api/go-env-client";
import { GO_NOT_FOUND, type GoEnv, type GoEnvResponse, goToolchain } from "@/api/go-env-model";
import { selectGoToolchain } from "@/lib/go-toolchain";
import { useActiveToolchainStatus } from "@/queries/use-toolchain-status";

import { ToolchainStatusButton } from "./ToolchainStatusButton";

const CLICK_TO_SELECT = "Click to select a Go toolchain, or to look for Go again";
const DOWNLOAD_IN_TERMINAL = "Running `go version` in the project from a terminal downloads it";
const CHOSEN_STAYS = "The Go chosen for this worktree stays in use until you select another";

const SOURCE_NOTES: Record<GoEnv["source"], string | null> = {
  path: null,
  chosen: "Chosen for this worktree",
  "module-cache": "From the module cache, where a terminal downloaded it for this project",
};

function goTooltip({ env, chosen }: GoEnvResponse): string {
  const chosenUnusable =
    chosen !== null &&
    env?.source !== "chosen" &&
    `The chosen Go ${chosen} cannot be used, so detection is in use`;
  if (!env) {
    return [GO_NOT_FOUND, chosenUnusable, "Loxel does not install Go", CLICK_TO_SELECT]
      .filter(Boolean)
      .join("\n");
  }
  const { newerGoNeeded: needed, newerToolchainSuggested: suggested } = env;
  const howToGetIt = env.source === "chosen" ? CHOSEN_STAYS : DOWNLOAD_IN_TERMINAL;
  return [
    env.binary,
    SOURCE_NOTES[env.source],
    chosenUnusable,
    !env.version && "This go did not report its version",
    env.goroot && `GOROOT: ${env.goroot}`,
    env.gowork && `Workspace: ${env.gowork}`,
    env.gomod && `Module: ${env.gomod}`,
    !env.gowork && !env.gomod && "No go.mod or go.work at the worktree root",
    `gopls: ${env.gopls ?? "bundled with Loxel"}`,
    needed &&
      `${needed.file} needs Go ${needed.version}, and the Go in use is ${env.version}. Loxel does not download Go. ${howToGetIt}`,
    suggested &&
      `${suggested.file} suggests Go ${suggested.version}. Loxel does not download it and uses Go ${env.version}. ${howToGetIt}`,
    CLICK_TO_SELECT,
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
 * Clicking it opens the toolchain picker, which also looks for Go again.
 */
export function GoToolchainStatus() {
  const active = useActiveToolchainStatus(goToolchain, getGoEnv);

  if (!active) return null;

  const { wtPath, status } = active;
  const { env, chosen } = status;
  const chosenUnusable = chosen !== null && env?.source !== "chosen";

  return (
    <ToolchainStatusButton
      label={goLabel(env)}
      tooltip={goTooltip(status)}
      warning={!env?.version || env.newerGoNeeded !== null || chosenUnusable}
      onSelect={() => void selectGoToolchain(wtPath)}
    />
  );
}
