import { APPROVED_TEST_HASH } from "./approved-test-hash.ts";
import { currentTestHash } from "./safety-files.ts";

const actualHash = await currentTestHash();

if (actualHash !== APPROVED_TEST_HASH) {
  process.stdout.write(`
[WT TEST SAFETY] Refusing to run: the wt test suite or its safety infrastructure changed.

Before running any wt tests:
1. Read packages/wt/TEST_SAFETY.md in full.
2. Review every changed test and test helper for destructive Git, filesystem, and hook behavior.
3. Use the acknowledgement command documented there to regenerate the approved hash.
4. Review the generated hash diff before rerunning the tests.

Expected hash: ${APPROVED_TEST_HASH}
Actual hash:   ${actualHash}

Do not bypass this preload or copy the hash manually.
`);
  process.exit(1);
}

// Do not let ambient repository or shell configuration redirect an approved test away from its
// reviewed temporary paths or cause bash/git to load developer-owned hooks and startup scripts.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
for (const key of ["BASH_ENV", "ENV", "TEMP", "TMP", "TMPDIR", "WT_AUTO_UPDATE", "WT_DIR"]) {
  delete process.env[key];
}
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";
