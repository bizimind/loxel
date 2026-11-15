/**
 * Builds and stages what ships next to `loxel-server` for language servers. Each binary is one
 * manifest in scripts/language-servers/, so a new one edits no shared file:
 *
 *   { "script": "download-x.ts", "resources": ["x"], "platforms"?: ["darwin"] }
 *
 * `script` (in scripts/) writes `resources` (paths under build/). Each resource is staged by its
 * base name in build/language-servers/, which electron-builder.yml `extraResources` copies as a
 * whole. A manifest with `platforms` does not exist elsewhere.
 *
 *   build [manifest...]  run the scripts; with no names, also stage everything
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import { $ } from "bun";

const LOXEL = path.resolve(import.meta.dir, "..");
const BUILD_DIR = path.join(LOXEL, "build");
const STAGE_DIR = path.join(BUILD_DIR, "language-servers");
const MANIFEST_DIR = path.join(import.meta.dir, "language-servers");

interface Manifest {
  name: string;
  script: string;
  resources: string[];
  platforms?: string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

async function readManifest(file: string): Promise<Manifest> {
  const raw: unknown = await Bun.file(path.join(MANIFEST_DIR, file)).json();
  if (typeof raw !== "object" || raw === null) throw new Error(`${file}: not an object`);
  const { script, resources, platforms } = raw as Record<string, unknown>;
  if (
    typeof script !== "string" ||
    !isStringArray(resources) ||
    (platforms !== undefined && !isStringArray(platforms))
  ) {
    throw new Error(`${file}: expected script, resources and optionally platforms`);
  }
  return { name: path.basename(file, ".json"), script, resources, platforms };
}

/** This platform's manifests, in name order so the build is the same everywhere. */
async function readManifests(): Promise<Manifest[]> {
  const files = readdirSync(MANIFEST_DIR).filter((file) => file.endsWith(".json"));
  const manifests = await Promise.all(files.toSorted().map(readManifest));
  return manifests.filter((m) => !m.platforms || m.platforms.includes(process.platform));
}

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

const [command, ...args] = Bun.argv.slice(2);
if (command === "build") await build(args);
else throw new Error(`Usage: language-server-binaries.ts build [manifest...]`);
