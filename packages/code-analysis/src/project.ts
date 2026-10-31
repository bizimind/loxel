import { accessSync, constants, existsSync, statSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SOURCE_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mjs", "cjs"];

export const SOURCE_GLOBS = SOURCE_EXTENSIONS.map((ext) => `**/*.${ext}`);

export type ProjectFile = { path: string; bytes: number };

/**
 * The regular files of the project at workDir, as paths relative to it: what git tracks
 * plus untracked files it does not ignore. Outside a git repository, without git, or when
 * workDir is itself ignored, it is every file except `node_modules`, `.git` and `dist`.
 */
export async function listProjectFiles(workDir: string): Promise<ProjectFile[]> {
  const gitPaths = await listFromGit(workDir);
  const paths = gitPaths?.length ? gitPaths : await listWithFind(workDir);
  const files = await Promise.all(
    paths.map(async (path) => {
      const stat = await lstat(join(workDir, path)).catch(() => null);
      // Skips tracked files deleted from the working tree, submodules and symlinks.
      return stat?.isFile() ? { path, bytes: stat.size } : null;
    }),
  );
  return files.filter((file) => file !== null);
}

async function listFromGit(workDir: string): Promise<string[] | null> {
  try {
    const proc = Bun.spawn(
      [
        "git",
        // Listing files must not start the fsmonitor a repository's config names.
        "-c",
        "core.fsmonitor=false",
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        // A project that has not ignored its dependencies yet still doesn't count them.
        "--exclude=node_modules",
        "-z",
      ],
      { cwd: workDir, stdout: "pipe", stderr: "ignore" },
    );
    const [text, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return null;
    // A path with a merge conflict is listed once per stage.
    return [...new Set(text.split("\0").filter(Boolean))];
  } catch {
    return null; // git is not installed
  }
}

async function listWithFind(workDir: string): Promise<string[]> {
  const proc = Bun.spawn(
    [
      "find",
      ".",
      "-type",
      "f",
      "-not",
      "-path",
      "*/node_modules/*",
      "-not",
      "-path",
      "*/.git/*",
      "-not",
      "-path",
      "*/dist/*",
      "-print0",
    ],
    { cwd: workDir, stdout: "pipe", stderr: "ignore" },
  );
  const text = await new Response(proc.stdout).text();
  return text
    .split("\0")
    .filter(Boolean)
    .map((path) => path.replace(/^\.\//, ""));
}

/**
 * workDir and its parents up to the root of its git repository. Outside a repository the
 * project is workDir alone, so a tool or config in some parent directory is never picked
 * up: /tmp/node_modules/.bin/tsc does not belong to /tmp/scratch.
 */
function projectDirs(workDir: string): string[] {
  const dirs: string[] = [];
  let dir = workDir;
  for (;;) {
    dirs.push(dir);
    if (existsSync(join(dir, ".git"))) return dirs;
    const parent = dirname(dir);
    if (parent === dir) return [workDir];
    dir = parent;
  }
}

/**
 * The path of a tool the project has installed, or null. Loxel never fetches a tool, so
 * this is the only way plugins find one: `bunx` would download whatever is missing.
 */
export function findInstalledBin(workDir: string, name: string): string | null {
  for (const dir of projectDirs(workDir)) {
    const bin = join(dir, "node_modules", ".bin", name);
    if (isExecutableFile(bin)) return bin;
  }
  return null;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The nearest tsconfig.json or jsconfig.json; in one directory, tsconfig wins as in tsc. */
export function findProjectConfig(workDir: string): string | null {
  for (const dir of projectDirs(workDir)) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const config = join(dir, name);
      if (existsSync(config)) return config;
    }
  }
  return null;
}
