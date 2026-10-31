/**
 * Import ahead of anything that opens the store database, for a test file that does so only in
 * passing, to keep the test's state out of the real one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "loxel-test-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
process.on("exit", () => {
  rmSync(stateDir, { recursive: true, force: true });
});
