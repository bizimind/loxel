import { join } from "node:path";

const packageRoot = join(import.meta.dir, "..");
const excludedPath = "test/approved-test-hash.ts";

export function isBunTestFile(path: string): boolean {
  return /(?:\.|_)(?:test|spec)\.(?:js|jsx|ts|tsx)$/.test(path);
}

/** Files whose content must be reviewed before the wt test suite is allowed to run. */
export async function safetyReviewedFiles(): Promise<string[]> {
  const files = new Set([
    "../../bunfig.toml",
    "bunfig.toml",
    "package.json",
    "TEST_SAFETY.md",
    "src/test-repo.ts",
  ]);

  for (const pattern of ["src/**/*.{js,jsx,ts,tsx}", "test/**/*"]) {
    const glob = new Bun.Glob(pattern);
    for await (const path of glob.scan({ cwd: packageRoot, onlyFiles: true })) {
      if (path !== excludedPath && (path.startsWith("test/") || isBunTestFile(path))) {
        files.add(path);
      }
    }
  }

  return [...files].sort();
}

/** Hash both paths and contents so adding, removing, renaming, or editing a test changes the hash. */
export async function currentTestHash(): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");

  for (const path of await safetyReviewedFiles()) {
    hasher.update(path);
    hasher.update("\0");
    hasher.update(await Bun.file(join(packageRoot, path)).arrayBuffer());
    hasher.update("\0");
  }

  return hasher.digest("hex");
}

export const testSafetyDocument = join(packageRoot, "TEST_SAFETY.md");
export const approvedHashFile = join(packageRoot, excludedPath);
