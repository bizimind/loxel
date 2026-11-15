import { getRustToolchain } from "@/api/rust-toolchain-client";
import { rustToolchain } from "@/api/rust-toolchain-model";
import {
  rustToolchainLabel,
  rustToolchainTooltip,
  selectRustToolchain,
} from "@/lib/rust-toolchain";
import { useActiveToolchainStatus } from "@/queries/use-toolchain-status";

import { ToolchainStatusButton } from "./ToolchainStatusButton";

/**
 * The Rust toolchain of the active editor's worktree, shown while that editor holds a Rust file.
 * Clicking it opens the toolchain picker for that worktree.
 */
export function RustToolchainStatus() {
  const active = useActiveToolchainStatus(rustToolchain, getRustToolchain);

  if (!active) return null;

  const { wtPath, status } = active;
  const { toolchain, chosen } = status;
  const chosenUnusable =
    chosen !== null && (toolchain.status !== "active" || toolchain.source !== "chosen");
  const tooltip = [
    rustToolchainTooltip(toolchain),
    chosenUnusable && `The chosen toolchain ${chosen} cannot be used, so detection picked this one`,
    "Click to select a toolchain",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <ToolchainStatusButton
      label={rustToolchainLabel(toolchain)}
      tooltip={tooltip}
      warning={toolchain.status !== "active" || chosenUnusable}
      onSelect={() => void selectRustToolchain(wtPath)}
    />
  );
}
