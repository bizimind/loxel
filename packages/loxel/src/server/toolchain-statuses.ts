/**
 * Every language's toolchain status module: one import and one entry per module, both sorted. Only
 * lists belong in this file: a local `git merge` combines parallel additions by itself
 * (`merge=union` in `.gitattributes`). GitHub's own merge ignores that and reports a conflict when
 * two branches insert at the same spot; merging main locally then needs no edits.
 */
import { goToolchainStatus } from "./go-toolchain-status";
import { javaToolchainStatus } from "./java-toolchain-status";
import { pythonToolchainStatus } from "./python-toolchain-status";
import { rustToolchainStatus } from "./rust-toolchain-status";
import type { ToolchainStatusModule } from "./toolchain-status-module";

export const toolchainStatusModules: readonly ToolchainStatusModule[] = [
  // This comment keeps the list on one line per entry whatever its length.
  goToolchainStatus,
  javaToolchainStatus,
  pythonToolchainStatus,
  rustToolchainStatus,
];
