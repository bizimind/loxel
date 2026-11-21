/**
 * Fails when a tracked file compiles a standalone binary without the shared flags in
 * `src/bun-compile.ts`: a `--compile` flag, or a `compile` option of `Bun.build` (any value: true,
 * a target string, a variable or an options object), outside that helper, its test and this check.
 * Comments and Markdown may mention either. Run by the root `lint` script.
 *
 * Usage: bun packages/cli-common/scripts/check-bun-compile.ts
 */
import path from "node:path";

import { $ } from "bun";

const HELPER_FILES = new Set([
  "packages/cli-common/src/bun-compile.ts",
  "packages/cli-common/src/bun-compile.test.ts",
  "packages/cli-common/scripts/check-bun-compile.ts",
]);
const COMMENT = /^\s*(?:\/\/|\/\*|\*|#)/;

const repoRoot = path.resolve(import.meta.dirname, "../../..");
// `--compile` not followed by `-`, so other tools' `--compile-*` flags do not match.
const COMPILE_FLAG = "--compile([^-]|$)";
// A `compile` key with any value, quoted or not; `-` and `.` are excluded before it so the
// `bun-compile` bin and export names do not match.
const COMPILE_OPTION =
  "(^|[^-.[:alnum:]_])[\"']?compile[\"']?[[:space:]]*:[[:space:]]*[^[:space:]]";
const grep = await $`git grep -n -I -E -e ${COMPILE_FLAG} -e ${COMPILE_OPTION} -- ${":!*.md"}`
  .cwd(repoRoot)
  .nothrow()
  .quiet();
if (grep.exitCode > 1) throw new Error(`git grep failed: ${grep.stderr.toString()}`);

const offending = grep.stdout
  .toString()
  .split("\n")
  .filter((line) => {
    const [file = "", , ...text] = line.split(":");
    return line !== "" && !HELPER_FILES.has(file) && !COMMENT.test(text.join(":"));
  });

if (offending.length > 0) {
  console.error(
    "Compile standalone binaries through @bizimind/cli-common/bun-compile (BUN_COMPILE_FLAGS or the bun-compile bin), not with --compile or Bun.build's compile option directly:",
  );
  for (const line of offending) console.error(`  ${line}`);
  process.exit(1);
}
