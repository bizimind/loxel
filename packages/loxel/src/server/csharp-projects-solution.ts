import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { config, hash12 } from "./config";
import { logger } from "./logger";

const SOLUTIONS_DIR = path.join(config.stateDir, "csharp-ls");
/** A `.sln`: SDKs before .NET 9 fail on a `.slnx`, and a repository's `global.json` may pick one. */
const SOLUTION_FILE = "Projects.sln";
const CSHARP_PROJECT_TYPE = "{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}";
const SOLUTION_FOLDER_TYPE = "{2150E333-8FDC-42A3-9474-1A3956D46DE8}";
/**
 * What the format cannot hold in a path between quotes on one line. A backslash would be read as a
 * separator, which could name another file.
 */
const UNLISTABLE_PATH = /["\\\r\n]/;
const log = logger.child("csharp-lsp");

function solutionDir(wtPath: string): string {
  return path.join(SOLUTIONS_DIR, hash12(path.resolve(wtPath)));
}

/** Where a worktree's solution is, or would be. */
export function projectsSolutionPath(wtPath: string): string {
  return path.join(solutionDir(wtPath), SOLUTION_FILE);
}

/** Ids and names stand for the position, and go no further than this file. */
function solutionId(kind: number, index: number): string {
  return `{00000000-0000-0000-${String(kind).padStart(4, "0")}-${String(index).padStart(12, "0")}}`;
}

function solutionEntry(type: string, name: string, location: string, id: string): string {
  return `Project("${type}") = "${name}", "${location}", "${id}"\nEndProject\n`;
}

/**
 * Each project in a solution folder of its own: a solution names a project after its file, and
 * refuses two of the same name in one folder, as `a/App.csproj` and `b/App.csproj` would be.
 */
function solutionText(projects: readonly string[]): string {
  const listable = projects.filter((project) => {
    const fits = !UNLISTABLE_PATH.test(project);
    if (!fits)
      log.warn("Leaving a C# project out: its path has no form in a solution", { project });
    return fits;
  });
  const entries = listable.flatMap((project, index) => [
    solutionEntry(SOLUTION_FOLDER_TYPE, `F${index}`, `F${index}`, solutionId(1, index)),
    solutionEntry(CSHARP_PROJECT_TYPE, `P${index}`, project, solutionId(2, index)),
  ]);
  const nesting = listable.map(
    (_, index) => `\t\t${solutionId(2, index)} = ${solutionId(1, index)}\n`,
  );
  return [
    "Microsoft Visual Studio Solution File, Format Version 12.00\n",
    ...entries,
    "Global\n\tGlobalSection(NestedProjects) = preSolution\n",
    ...nesting,
    "\tEndGlobalSection\nEndGlobal\n",
  ].join("");
}

/**
 * Tells csharp-ls what to load when the worktree has no solution of its own: without `--solution` it
 * searches the disk, past what discovery lists. Lives outside the worktree, private, under a name
 * that stays the same for the worktree, and is only written when its content changes.
 */
export function writeProjectsSolution(wtPath: string, projects: readonly string[]): string {
  const dir = solutionDir(wtPath);
  const file = projectsSolutionPath(wtPath);
  const content = solutionText(projects);
  if (readExisting(file) === content) return file;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temporary = `${file}.${randomUUID()}`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, file);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
  return file;
}

function readExisting(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Forget a removed worktree's solution. */
export function deleteProjectsSolution(wtPath: string): void {
  try {
    rmSync(solutionDir(wtPath), { recursive: true, force: true });
  } catch (err) {
    log.debug("Deleting the projects solution failed", { error: err });
  }
}
