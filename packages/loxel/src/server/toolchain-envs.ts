/**
 * Every toolchain that contributes to terminal environments: one import and one
 * entry per toolchain, both sorted. Contributions apply in this order. Only lists belong in this
 * file: a local `git merge` combines parallel additions by itself (`merge=union` in
 * `.gitattributes`). GitHub's own merge ignores that and reports a conflict when two branches
 * insert at the same spot; merging main locally then needs no edits.
 */
import { goToolchainEnv } from "./go-toolchain-env";
import { pythonToolchainEnv } from "./python-toolchain-env";
import type { ToolchainEnvContributor } from "./toolchain-env-contributor";

export const toolchainEnvs: readonly ToolchainEnvContributor[] = [
  // This comment keeps the list on one line per entry whatever its length.
  goToolchainEnv,
  pythonToolchainEnv,
];
