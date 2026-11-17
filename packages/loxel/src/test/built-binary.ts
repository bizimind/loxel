/**
 * For suites that run a language server binary from build/, which only a build makes. Locally a
 * suite without it is skipped; in CI, where a skip would hide a binary that no longer builds, it
 * fails. The CI test job builds the binaries these suites need (see .github/workflows/ci.yml).
 */
export async function builtBinaryExists(path: string): Promise<boolean> {
  if (await Bun.file(path).exists()) return true;
  if (process.env.CI) {
    throw new Error(`${path} is missing: CI's test job must build it before the tests run`);
  }
  return false;
}
