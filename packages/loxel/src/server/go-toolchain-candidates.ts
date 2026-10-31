/**
 * The Go installs the picker offers, and the check on a path the user enters. Runs only when the
 * picker opens or a choice is made. Nothing here reads a path from the repository.
 */
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { GoEnv, GoToolchainChoice } from "@/api/go-env-model";
import { isDirectory } from "@/fs-utils";

import {
  cachedGo,
  cachedToolchainVersion,
  compareGoVersions,
  GO,
  goBehindShim,
  goToolPath,
  goVersion,
  isExecutableFile,
  isShim,
  isTrustedBinary,
  realpathOr,
} from "./go-env";
import { buildSpawnEnv } from "./shell-env";

/** The names in `dir`, none when it cannot be read: most of these directories do not exist. */
function entriesOf(dir: string): string[] {
  try {
    return readdirSync(dir).toSorted();
  } catch {
    return [];
  }
}

/** Where version managers and installers keep Go, as `go` binaries that may or may not exist. */
function installedGoPaths(home: string): string[] {
  const spawnEnv = buildSpawnEnv();
  const inside = (parent: string, ...below: string[]) =>
    entriesOf(parent).map((name) => path.join(parent, name, ...below));
  const homebrewOpts = ["/opt/homebrew/opt", "/usr/local/opt", "/home/linuxbrew/.linuxbrew/opt"];
  const miseData = spawnEnv.MISE_DATA_DIR ?? path.join(home, ".local", "share", "mise");
  const asdfData = spawnEnv.ASDF_DATA_DIR ?? path.join(home, ".asdf");
  const sdk = path.join(home, "sdk");
  return [
    ...entriesOf(sdk)
      .filter((name) => name.startsWith("go"))
      .map((name) => path.join(sdk, name, "bin", GO)),
    path.join("/usr/local/go/bin", GO),
    ...homebrewOpts.flatMap((opt) =>
      entriesOf(opt)
        .filter((name) => name === "go" || name.startsWith("go@"))
        .map((name) => path.join(opt, name, "bin", GO)),
    ),
    ...inside(path.join(miseData, "installs", "go"), "bin", GO),
    ...inside(path.join(asdfData, "installs", "golang"), "go", "bin", GO),
  ];
}

async function pathGo(wtPath: string): Promise<string | null> {
  const binary = Bun.which(GO, { PATH: goToolPath(wtPath) });
  if (!binary) return null;
  return isShim(binary) ? goBehindShim(wtPath, binary) : binary;
}

/** The toolchains in the module cache, for this platform and with the name's strict shape. */
async function cachedGoPaths(wtPath: string, env: GoEnv | null): Promise<string[]> {
  const { gomodcache, toolchainPlatform } = env ?? {};
  if (!gomodcache || !toolchainPlatform) return [];
  const names = entriesOf(path.join(gomodcache, "golang.org")).filter(
    (name) => cachedToolchainVersion(name, toolchainPlatform) !== null,
  );
  const found = await Promise.all(names.map((name) => cachedGo(wtPath, gomodcache, name)));
  return found.filter((go) => go !== null);
}

/**
 * Every Go on the machine that can be chosen for the worktree, newest first. `env` is a resolution
 * of the worktree, for where its module cache is. What is absent is left out silently.
 */
export async function listGoToolchains(
  wtPath: string,
  env: GoEnv | null,
  home = homedir(),
): Promise<GoToolchainChoice[]> {
  const [onPath, cached] = await Promise.all([pathGo(wtPath), cachedGoPaths(wtPath, env)]);
  const cachedSet = new Set(cached);
  const seen = new Set<string>();
  const unique = [...(onPath ? [onPath] : []), ...installedGoPaths(home), ...cached].filter(
    (go) => {
      const real = realpathOr(go);
      if (seen.has(real)) return false;
      seen.add(real);
      return true;
    },
  );
  const choices = await Promise.all(
    unique.map(async (go): Promise<GoToolchainChoice | null> => {
      if (!isExecutableFile(go) || isShim(go) || !(await isTrustedBinary(wtPath, go))) return null;
      const version = await goVersion(wtPath, go);
      return version ? { path: go, version, fromModuleCache: cachedSet.has(go) } : null;
    }),
  );
  return choices
    .filter((choice) => choice !== null)
    .toSorted((a, b) => compareGoVersions(b.version, a.version));
}

/**
 * Check a path the user entered for a worktree, a `go` binary or a GOROOT, `~/` allowed, and return
 * the `go` binary to store. A shim becomes the Go behind it. Throws an error meant for the user.
 */
export async function normalizeGoChoice(
  wtPath: string,
  input: string,
  home = homedir(),
): Promise<string> {
  const trimmed = input.trim();
  const expanded =
    trimmed === "~" || trimmed.startsWith("~/") ? path.join(home, trimmed.slice(1)) : trimmed;
  if (!path.isAbsolute(expanded))
    throw new Error("Enter an absolute path to a Go binary or GOROOT");
  const target = path.resolve(expanded);
  const entered = isDirectory(target) ? path.join(target, "bin", GO) : target;
  if (!isExecutableFile(entered)) throw new Error(`No executable Go at ${target}`);
  // Before anything runs it.
  const refused = "Loxel does not run a Go that is in the worktree or that a repository tracks";
  if (!(await isTrustedBinary(wtPath, entered))) throw new Error(refused);
  const go = isShim(entered) ? await goBehindShim(wtPath, entered) : entered;
  if (!go) throw new Error(`${entered} is a version manager's shim that names no usable Go`);
  if (!(await goVersion(wtPath, go))) {
    throw new Error(`${go} did not report a Go version; is it a Go binary?`);
  }
  return go;
}
