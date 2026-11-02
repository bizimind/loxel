import { getCSharpStatus } from "@/api/csharp-env-client";
import { csharpToolchain } from "@/api/csharp-env-model";
import {
  csharpStatusLabel,
  csharpStatusTooltip,
  csharpStatusWarning,
  selectCSharpSolution,
} from "@/lib/csharp-solution";
import { useActiveToolchainStatus } from "@/queries/use-toolchain-status";

import { ToolchainStatusButton } from "./ToolchainStatusButton";

/**
 * What the C# language server is doing for the active editor's worktree, shown while that editor
 * holds a C# file in a repository with a project. Clicking it opens the solution picker for that
 * worktree.
 */
export function CSharpStatus() {
  const active = useActiveToolchainStatus(csharpToolchain, getCSharpStatus);
  if (!active) return null;

  const { wtPath, status } = active;
  const label = csharpStatusLabel(status);
  if (!label) return null;

  return (
    <ToolchainStatusButton
      label={label}
      tooltip={csharpStatusTooltip(status, wtPath)}
      warning={csharpStatusWarning(status)}
      onSelect={() => void selectCSharpSolution(wtPath)}
    />
  );
}
