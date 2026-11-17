/**
 * Builds and stages what ships next to `loxel-server` for language servers. Each binary is one
 * manifest in scripts/language-servers/ (see language-server-manifest.ts), so a new one edits no
 * shared file. Each resource is staged by its base name in build/language-servers/, which
 * electron-builder.yml `extraResources` copies as a whole, as does the standalone server bundle
 * (build-server-bundle.ts). A manifest with `platforms` does not exist elsewhere.
 *
 *   build [manifest...]  run the scripts; with no names, also stage everything
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { $ } from "bun";

import { type Manifest, readManifests } from "./language-server-manifest";

const LOXEL = path.resolve(import.meta.dir, "..");
const BUILD_DIR = path.join(LOXEL, "build");
export const STAGE_DIR = path.join(BUILD_DIR, "language-servers");

/** A resource's built path; download scripts add `.exe` on Windows. */
function builtPath(resource: string): string {
  const built = path.join(BUILD_DIR, resource);
  if (existsSync(built)) return built;
  if (existsSync(`${built}.exe`)) return `${built}.exe`;
  throw new Error(`Missing ${built}: its script did not produce it`);
}

function stage(manifests: Manifest[]): void {
  rmSync(STAGE_DIR, { recursive: true, force: true });
  mkdirSync(STAGE_DIR, { recursive: true });
  for (const resource of manifests.flatMap((manifest) => manifest.resources)) {
    const built = builtPath(resource);
    const staged = path.join(STAGE_DIR, path.basename(built));
    if (existsSync(staged)) throw new Error(`Two resources stage as ${path.basename(built)}`);
    cpSync(built, staged, { recursive: true });
  }
}

async function build(names: string[]): Promise<void> {
  const manifests = await readManifests();
  const unknown = names.filter((name) => !manifests.some((manifest) => manifest.name === name));
  if (unknown.length > 0) throw new Error(`No manifest for: ${unknown.join(", ")}`);
  const selected = manifests.filter((m) => names.length === 0 || names.includes(m.name));
  for (const manifest of selected) {
    await $`bun ${path.join("scripts", manifest.script)}`.cwd(LOXEL);
  }
  if (names.length === 0) stage(manifests);
}

if (import.meta.main) {
  const [command, ...args] = Bun.argv.slice(2);
  if (command === "build") await build(args);
  else throw new Error(`Usage: language-server-binaries.ts build [manifest...]`);
}
