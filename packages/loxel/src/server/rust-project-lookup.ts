import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { readConfigFile } from "./config-file-read";
import { dirsUpToRoot } from "./language-formatter";
import { isRepoTrusted } from "./repo-trust";
import { isInside } from "./shipped-by-repo";
import { parseToml, recordAt } from "./toml-file";

export const RUST_MANIFEST = "Cargo.toml";

/** Folders whose Rust files are not this worktree's own project: dependencies and build output. */
const OTHER_PEOPLES_FOLDERS: ReadonlySet<string> = new Set([
  ".git",
  ".venv",
  ".worktrees",
  "dist-packages",
  "node_modules",
  "site-packages",
  "venv",
]);

/** What Cargo writes into a build directory; a crate may just be named `target`. */
const BUILD_DIRECTORY_MARKER = "CACHEDIR.TAG";

/** What `cargo vendor` leaves next to a vendored crate's manifest. */
const VENDORED_MARKER = ".cargo-checksum.json";

/**
 * What a `.git` file says in a linked worktree. A submodule's ends in `modules/<name>`, also when
 * it sits in a linked worktree, under `worktrees/<name>/modules/<name>`.
 */
const LINKED_WORKTREE_GITDIR = /^gitdir: .*[\\/]worktrees[\\/][^\\/]+\s*$/;

/** What rust-analyzer should load for a file. */
export type RustProject = { kind: "manifest"; manifest: string } | { kind: "loose"; file: string };

function realPathOf(file: string): string | null {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

/** A manifest's text, under the rule for project files, and only when it stays in the worktree. */
function readManifest(manifest: string, realRoot: string): string | undefined {
  const real = realPathOf(manifest);
  return real !== null && isInside(real, realRoot) ? readConfigFile(manifest) : undefined;
}

/** Whether `manifest` counts as a project of the worktree. */
export function isReadableRustManifest(manifest: string, wtPath: string): boolean {
  const realRoot = realPathOf(wtPath);
  return realRoot !== null && readManifest(manifest, realRoot) !== undefined;
}

/**
 * The folder between the worktree and `manifest` that is a repository of its own and not trusted, a
 * submodule included, or null. A worktree's trust does not reach it.
 */
export function untrustedNestedRepo(manifest: string, wtPath: string): string | null {
  const nested = dirsUpToRoot(path.dirname(manifest), path.resolve(wtPath)).slice(0, -1);
  return nested.find((dir) => existsSync(path.join(dir, ".git")) && !isRepoTrusted(dir)) ?? null;
}

function isLinkedWorktree(dir: string): boolean {
  const gitFile = readConfigFile(path.join(dir, ".git"));
  return gitFile !== undefined && LINKED_WORKTREE_GITDIR.test(gitFile);
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];

const relativeDir = (dir: string) => dir.replace(/^\.\//, "").replace(/\/+$/, "");

/** Where a workspace at `rootDir` puts the crate in `crateDir`, by Cargo's rule. */
function workspaceStance(
  workspace: Record<string, unknown>,
  rootDir: string,
  crateDir: string,
): "excluded" | "listed" | "unlisted" {
  const crate = path.relative(rootDir, crateDir);
  const underAny = (dirs: string[]) =>
    dirs.some((dir) => crate === dir || crate.startsWith(`${dir}${path.sep}`));
  const members = strings(workspace.members).map(relativeDir);
  if (underAny(strings(workspace.exclude).map(relativeDir)) && !underAny(members)) {
    return "excluded";
  }
  return members.some((member) => new Bun.Glob(member).match(crate)) ? "listed" : "unlisted";
}

/**
 * The manifest to load for the crate in `crateDir`: its workspace's when that is known from the
 * files alone, so a member adds nothing once its workspace is loaded, and otherwise its own, where
 * Cargo decides what it belongs to and says what is wrong. `above` are the directories up to the
 * worktree root.
 */
function projectManifest(crateDir: string, above: string[], realRoot: string): string {
  const own = path.join(crateDir, RUST_MANIFEST);
  const table = parseToml(readManifest(own, realRoot) ?? "");
  if (!table || recordAt(table, "workspace")) return own;
  const workspaceAt = (dir: string) =>
    recordAt(parseToml(readManifest(path.join(dir, RUST_MANIFEST), realRoot) ?? ""), "workspace");
  const named = recordAt(table, "package")?.workspace;
  if (typeof named === "string") {
    const dir = path.join(crateDir, named);
    const workspace = workspaceAt(dir);
    return workspace && workspaceStance(workspace, dir, crateDir) === "listed"
      ? path.join(dir, RUST_MANIFEST)
      : own;
  }
  for (const dir of above) {
    const workspace = workspaceAt(dir);
    if (!workspace) continue;
    const stance = workspaceStance(workspace, dir, crateDir);
    if (stance === "listed") return path.join(dir, RUST_MANIFEST);
    if (stance === "unlisted") return own;
  }
  return own;
}

/**
 * What rust-analyzer should load for an opened file of the worktree, or null for a file that is not
 * the worktree's own: outside it, reached through a link that leaves it, or in a dependency, build
 * output or another worktree nested in it. A file with no manifest up to the root is loose.
 */
export function findRustProject(file: string, wtPath: string): RustProject | null {
  const root = path.resolve(wtPath);
  if (!isInside(file, root) || file === root) return null;
  const folders = path.relative(root, file).split(path.sep).slice(0, -1);
  if (folders.some((folder) => OTHER_PEOPLES_FOLDERS.has(folder))) return null;
  const inBuildDirectory = folders.some(
    (folder, index) =>
      folder === "target" &&
      existsSync(path.join(root, ...folders.slice(0, index + 1), BUILD_DIRECTORY_MARKER)),
  );
  if (inBuildDirectory) return null;
  const realRoot = realPathOf(root);
  const realFile = realPathOf(file);
  if (realRoot === null || realFile === null || !isInside(realFile, realRoot)) return null;

  const dirs = dirsUpToRoot(path.dirname(file), root);
  if (dirs.slice(0, -1).some(isLinkedWorktree)) return null;
  const crateIndex = dirs.findIndex(
    (dir) => readManifest(path.join(dir, RUST_MANIFEST), realRoot) !== undefined,
  );
  if (crateIndex === -1) return { kind: "loose", file };
  const crateDir = dirs[crateIndex] ?? root;
  if (existsSync(path.join(crateDir, VENDORED_MARKER))) return null;
  const manifest = projectManifest(crateDir, dirs.slice(crateIndex + 1), realRoot);
  return { kind: "manifest", manifest };
}
