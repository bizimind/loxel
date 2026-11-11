/**
 * Build Loxel's patched Electron on a Mac and upload it to R2 for the release workflow:
 *
 *   pnpm run build:electron [-- --arch arm64 --arch x64] [--root <dir>] [--no-upload] [--force]
 *
 * Checks out the Electron release package.json pins, applies `electron/patches/`, and builds
 * Electron's release configuration for each architecture (x64 is cross-compiled on Apple silicon).
 * Each zip is checked for the right version and architecture, kept under its build ID, copied to
 * build/electron-dist for local packaging, and uploaded. A build already in R2 is skipped, and one
 * already built for this ID (e.g. by a --no-upload run) is only uploaded, unless --force. Needs Electron's build tools (`npm i -g @electron/build-tools`),
 * Xcode with its Metal toolchain, about 150 GB of disk, and the R2 credentials fetch-electron.ts
 * uses. See docs/PATCHED_ELECTRON.md.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

import {
  DIST_DIR,
  ELECTRON_ARCHES,
  type ElectronArch,
  PATCHES_DIR,
  buildIdMarker,
  currentBuild,
  distZipName,
  isUploaded,
  objectKey,
  parseArch,
  r2Client,
  readPatches,
  sha256File,
} from "./electron-dist";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    arch: { type: "string", multiple: true },
    root: { type: "string" },
    "no-upload": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  },
});

const arches: ElectronArch[] = values.arch?.map(parseArch) ?? [...ELECTRON_ARCHES];
const root = path.resolve(
  values.root ??
    process.env.LOXEL_ELECTRON_ROOT ??
    path.join(os.homedir(), "git", "open-source", "electron-loxel"),
);
const upload = !values["no-upload"];
const { version, id } = currentBuild();
const tag = `v${version}`;
const log = (message: string) => console.log(`[build-electron] ${message}`);

/** One build-tools config per architecture, sharing the checkout under `root`. */
const configName = (arch: ElectronArch) => `loxel-release-${arch}`;
const outDir = (arch: ElectronArch) => `Release-${arch}`;

async function checkPrerequisites(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Electron for macOS builds only on a Mac");
  if ((await $`command -v e`.nothrow().quiet()).exitCode !== 0) {
    throw new Error("Electron's build tools are missing: npm i -g @electron/build-tools");
  }
  if ((await $`xcrun -f metal`.nothrow().quiet()).exitCode !== 0) {
    throw new Error(
      "The Metal toolchain is missing (Xcode 26 ships it separately): " +
        "xcodebuild -downloadComponent MetalToolchain",
    );
  }
}

/**
 * Create the arch's build-tools config on first use. An existing one must build the checkout under
 * `root`: one made for another root would build there while the patches go here, and the zip read
 * back from here would be an older build.
 */
async function ensureConfig(arch: ElectronArch): Promise<void> {
  const configs = await $`e show configs`.nothrow().quiet().text();
  if (!configs.split(/\s+/).includes(configName(arch))) {
    log(`creating build config ${configName(arch)} in ${root}`);
    await $`e init ${configName(arch)} --root ${root} --import release --out ${outDir(arch)} --target-cpu ${arch} --remote-build none --use-https`;
    return;
  }
  await $`e use ${configName(arch)}`.quiet();
  const configRoot = path.resolve((await $`e show root`.text()).trim());
  if (configRoot !== root) {
    throw new Error(
      `Build config ${configName(arch)} builds ${configRoot}, not ${root}. ` +
        `Run with --root ${configRoot}, or remove it with \`e remove ${configName(arch)}\`.`,
    );
  }
}

/** Check out the pinned release with the patches on top, and sync its dependencies. */
async function prepareSource(arch: ElectronArch): Promise<void> {
  const electronSrc = path.join(root, "src", "electron");
  await $`e use ${configName(arch)}`;
  if (!existsSync(electronSrc)) {
    log("first sync: cloning Electron and Chromium (about 30 GB)");
    await $`e sync`;
  }
  await $`git am --abort`.cwd(electronSrc).nothrow().quiet();
  await $`git fetch --no-tags origin refs/tags/${tag}:refs/tags/${tag}`.cwd(electronSrc);
  await $`git checkout --detach --force ${tag}`.cwd(electronSrc);
  log(`applying patches from ${PATCHES_DIR}`);
  const patchFiles = readPatches().map((patch) => path.join(PATCHES_DIR, patch.name));
  await $`git -c user.name=loxel-build -c user.email=loxel-build@invalid am --3way ${patchFiles}`.cwd(
    electronSrc,
  );
  log(`syncing dependencies for ${tag}`);
  await $`e sync`;
}

/** Build one architecture's dist zip and check it before anything is uploaded. */
async function buildArch(arch: ElectronArch): Promise<string> {
  await $`e use ${configName(arch)}`;
  log(`building ${tag} darwin-${arch} (release configuration; hours on a laptop)`);
  await $`e build -t electron:electron_dist_zip`;
  const zip = path.join(root, "src", "out", outDir(arch), "dist.zip");

  const scratch = mkdtempSync(path.join(os.tmpdir(), "loxel-electron-"));
  try {
    await $`unzip -q ${zip} Electron.app/Contents/Info.plist Electron.app/Contents/MacOS/Electron -d ${scratch}`;
    const app = path.join(scratch, "Electron.app", "Contents");
    const built =
      await $`plutil -extract CFBundleShortVersionString raw ${path.join(app, "Info.plist")}`.text();
    if (built.trim() !== version)
      throw new Error(`Built Electron ${built.trim()}, expected ${version}`);
    const archs = (await $`lipo -archs ${path.join(app, "MacOS", "Electron")}`.text()).trim();
    const expected = arch === "x64" ? "x86_64" : "arm64";
    if (archs !== expected) throw new Error(`Built Electron for ${archs}, expected ${expected}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return zip;
}

/** Where a checked zip of this build is kept, under its build ID. */
const keptZip = (arch: ElectronArch) =>
  path.join(root, "loxel-dist", id, distZipName(version, arch));

await checkPrerequisites();
const client = upload ? r2Client() : undefined;
const toUpload: ElectronArch[] = [];
const toBuild: ElectronArch[] = [];
for (const arch of arches) {
  if (client && !values.force && (await isUploaded(client, id, version, arch))) {
    log(`${id} darwin-${arch} is already in R2; skipping (--force rebuilds it)`);
    continue;
  }
  toUpload.push(arch);
  // A zip this build ID already produced, e.g. by a --no-upload run, only needs uploading.
  if (values.force || !existsSync(`${keptZip(arch)}.sha256`)) toBuild.push(arch);
  else log(`${id} darwin-${arch} was already built; reusing ${keptZip(arch)}`);
}

if (toBuild.length > 0) {
  for (const arch of toBuild) await ensureConfig(arch);
  await prepareSource(toBuild[0]!);
}

for (const arch of toUpload) {
  const kept = keptZip(arch);
  if (toBuild.includes(arch)) {
    const zip = await buildArch(arch);
    mkdirSync(path.dirname(kept), { recursive: true });
    cpSync(zip, kept);
    await Bun.write(`${kept}.sha256`, `${await sha256File(kept)}\n`);
  }
  const checksum = (await Bun.file(`${kept}.sha256`).text()).trim();
  log(`${path.basename(kept)} sha256 ${checksum} -> ${kept}`);

  // Also where build-app.ts packages it from, marked with its build ID.
  const local = path.join(DIST_DIR, path.basename(kept));
  mkdirSync(DIST_DIR, { recursive: true });
  cpSync(kept, local);
  await Bun.write(buildIdMarker(local), `${id}\n`);

  if (!client) continue;
  const zipName = path.basename(kept);
  await client.file(objectKey(id, zipName)).write(Bun.file(kept));
  // The checksum goes last: a build counts as uploaded only once both exist (isUploaded).
  await client.file(objectKey(id, `${zipName}.sha256`)).write(`${checksum}\n`);
  log(`uploaded ${objectKey(id, zipName)}`);
}
log(`done: Electron ${id}`);
