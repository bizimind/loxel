/**
 * Test safety preload script.
 *
 * Blocks dangerous operations that could affect the real filesystem or git repo.
 * Individual tests can override these mocks using mock.module() if needed.
 */
import { mock } from "bun:test";

const createBlockedFn = (name: string) => () => {
  throw new Error(
    `[TEST SAFETY] ${name} is blocked in tests. ` +
      `Use dependency injection or mock.module() to provide a test implementation.`,
  );
};

// =============================================================================
// Block Bun globals
// =============================================================================

// Block shell execution (used for git commands)
// @ts-expect-error - intentionally replacing with blocked version
Bun.$ = createBlockedFn("Bun.$");

// Block Bun.spawn/spawnSync
// @ts-expect-error - intentionally replacing with blocked version
Bun.spawn = createBlockedFn("Bun.spawn");
// @ts-expect-error - intentionally replacing with blocked version
Bun.spawnSync = createBlockedFn("Bun.spawnSync");

// Block Bun.write (file writes)
// @ts-expect-error - intentionally replacing with blocked version
Bun.write = createBlockedFn("Bun.write");

// =============================================================================
// Block node:fs/promises (async filesystem operations)
// =============================================================================
mock.module("node:fs/promises", () => ({
  // Dangerous - blocked
  writeFile: createBlockedFn("fs.writeFile"),
  mkdir: createBlockedFn("fs.mkdir"),
  rm: createBlockedFn("fs.rm"),
  rmdir: createBlockedFn("fs.rmdir"),
  rename: createBlockedFn("fs.rename"),
  cp: createBlockedFn("fs.cp"),
  copyFile: createBlockedFn("fs.copyFile"),
  unlink: createBlockedFn("fs.unlink"),
  symlink: createBlockedFn("fs.symlink"),
  link: createBlockedFn("fs.link"),
  chmod: createBlockedFn("fs.chmod"),
  chown: createBlockedFn("fs.chown"),
  truncate: createBlockedFn("fs.truncate"),
  appendFile: createBlockedFn("fs.appendFile"),
}));

// =============================================================================
// Block node:fs (sync filesystem operations)
// =============================================================================
mock.module("node:fs", () => ({
  // Dangerous - blocked
  writeFileSync: createBlockedFn("fs.writeFileSync"),
  mkdirSync: createBlockedFn("fs.mkdirSync"),
  rmSync: createBlockedFn("fs.rmSync"),
  rmdirSync: createBlockedFn("fs.rmdirSync"),
  renameSync: createBlockedFn("fs.renameSync"),
  cpSync: createBlockedFn("fs.cpSync"),
  copyFileSync: createBlockedFn("fs.copyFileSync"),
  unlinkSync: createBlockedFn("fs.unlinkSync"),
  symlinkSync: createBlockedFn("fs.symlinkSync"),
  linkSync: createBlockedFn("fs.linkSync"),
  chmodSync: createBlockedFn("fs.chmodSync"),
  chownSync: createBlockedFn("fs.chownSync"),
  truncateSync: createBlockedFn("fs.truncateSync"),
  appendFileSync: createBlockedFn("fs.appendFileSync"),
}));

// =============================================================================
// Block node:child_process
// =============================================================================
mock.module("node:child_process", () => ({
  spawn: createBlockedFn("child_process.spawn"),
  spawnSync: createBlockedFn("child_process.spawnSync"),
  exec: createBlockedFn("child_process.exec"),
  execSync: createBlockedFn("child_process.execSync"),
  execFile: createBlockedFn("child_process.execFile"),
  execFileSync: createBlockedFn("child_process.execFileSync"),
  fork: createBlockedFn("child_process.fork"),
}));

// =============================================================================
// Block dangerous process methods
// =============================================================================
process.exit = ((code?: number) => {
  throw new Error(
    `[TEST SAFETY] process.exit(${code}) is blocked in tests. ` +
      `Throw an error instead or use expect().toThrow().`,
  );
}) as typeof process.exit;

process.chdir = ((directory: string) => {
  throw new Error(
    `[TEST SAFETY] process.chdir("${directory}") is blocked in tests. ` +
      `Pass cwd as a parameter instead.`,
  );
}) as typeof process.chdir;
