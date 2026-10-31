/**
 * Every language's toolchain status item: one import and one entry per item, both sorted. Only
 * lists belong in this file: a local `git merge` combines parallel additions by itself
 * (`merge=union` in `.gitattributes`). GitHub's own merge ignores that and reports a conflict when
 * two branches insert at the same spot; merging main locally then needs no edits.
 */
import { goToolchainStatusItem } from "./go-toolchain-status";
import { javaToolchainStatusItem } from "./java-toolchain-status";
import { pythonToolchainStatusItem } from "./python-toolchain-status";
import { rustToolchainStatusItem } from "./rust-toolchain-status";
import type { ToolchainStatusItem } from "./toolchain-status-item";

export const toolchainStatusItems: readonly ToolchainStatusItem[] = [
  // This comment keeps the list on one line per entry whatever its length.
  goToolchainStatusItem,
  javaToolchainStatusItem,
  pythonToolchainStatusItem,
  rustToolchainStatusItem,
];
