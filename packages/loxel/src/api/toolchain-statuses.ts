/**
 * Every language with a toolchain status item: one import and one entry per language, both sorted.
 * Only lists belong in this file: a local `git merge` combines parallel additions by itself
 * (`merge=union` in `.gitattributes`). GitHub's own merge ignores that and reports a conflict when
 * two branches insert at the same spot; merging main locally then needs no edits.
 */
import { goToolchain } from "./go-env-model";
import { javaToolchain } from "./java-env-model";
import { pythonToolchain } from "./python-env-model";
import { rustToolchain } from "./rust-toolchain-model";

export const toolchainStatuses = [
  // This comment keeps the list on one line per entry whatever its length.
  goToolchain,
  javaToolchain,
  pythonToolchain,
  rustToolchain,
] as const;
