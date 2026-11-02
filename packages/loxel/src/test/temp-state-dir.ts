/**
 * Preloaded by `bunfig.toml` for tests run from the package directory (`pnpm -C packages/loxel run
 * test`, `bun test --cwd packages/loxel`), to keep their state out of the real state directory. A file that needs its own sets `LOXEL_STATE_DIR` before importing the server code.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "loxel-test-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});
