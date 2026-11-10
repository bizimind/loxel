/**
 * Build Loxel's patched Electron on a Mac and upload it to R2 for the release workflow:
 *
 *   pnpm run build:electron [-- --arch arm64 --arch x64] [--root <dir>] [--no-upload] [--force]
 *
 * Checks out the Electron release package.json pins, applies `electron/patches/`, and builds
 * Electron's release configuration for each architecture (x64 is cross-compiled on Apple silicon).
 * Each zip is checked for the right version and architecture before it is uploaded. A build already
 * in R2 is skipped unless --force. Needs Electron's build tools (`npm i -g @electron/build-tools`),
 * Xcode with its Metal toolchain, about 150 GB of disk, and the R2 credentials fetch-electron.ts
 * uses. See docs/PATCHED_ELECTRON.md.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

import {
  ELECTRON_ARCHES,
  type ElectronArch,
  PATCHES_DIR,
  currentBuild,
  distZipName,
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

/** Create the arch's build-tools config on first use. */
async function ensureConfig(arch: ElectronArch): Promise<void> {
  const configs = await $`e show configs`.nothrow().quiet().text();
  if (configs.split(/\s+/).includes(configName(arch))) return;
  log(`creating build config ${configName(arch)} in ${root}`);
  await $`e init ${configName(arch)} --root ${root} --import release --out ${outDir(arch)} --target-cpu ${arch} --remote-build none --use-https`;
}

/** Check out the pinned release with the patches on top, and sync its dependencies. */
async function prepareSource(): Promise<void> {
  const electronSrc = path.join(root, "src", "electron");
  await $`e use ${configName(arches[0]!)}`;
  if (!existsSync(electronSrc)) {
    log("first sync: cloning Electron and Chromium (about 30 GB)");
    await $`e sync`;
  }
  const git = $.cwd(electronSrc);
  await git`git am --abort`.nothrow().quiet();
  await git`git fetch --no-tags origin refs/tags/${tag}:refs/tags/${tag}`;
  await git`git checkout --detach --force ${tag}`;
  log(`applying patches from ${PATCHES_DIR}`);
  const patchFiles = readPatches().map((patch) => path.join(PATCHES_DIR, patch.name));
  await git`git -c user.name=loxel-build -c user.email=loxel-build@invalid am --3way ${patchFiles}`;
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

await checkPrerequisites();
const client = upload ? r2Client() : undefined;
const pending: ElectronArch[] = [];
for (const arch of arches) {
  const zipName = distZipName(version, arch);
  if (client && !values.force && (await client.file(objectKey(id, zipName)).exists())) {
    log(`${id} darwin-${arch} is already in R2; skipping (--force rebuilds it)`);
    continue;
  }
  pending.push(arch);
}

if (pending.length > 0) {
  for (const arch of pending) await ensureConfig(arch);
  await prepareSource();
}

for (const arch of pending) {
  const zip = await buildArch(arch);
  const zipName = distZipName(version, arch);
  const kept = path.join(root, "loxel-dist", id, zipName);
  mkdirSync(path.dirname(kept), { recursive: true });
  cpSync(zip, kept);
  const checksum = await sha256File(kept);
  await Bun.write(`${kept}.sha256`, `${checksum}\n`);
  log(`${zipName} sha256 ${checksum} -> ${kept}`);
  if (!client) continue;
  await client.file(objectKey(id, zipName)).write(Bun.file(kept));
  // The checksum goes last: fetch-electron.ts treats a build as present only when both exist.
  await client.file(objectKey(id, `${zipName}.sha256`)).write(`${checksum}\n`);
  log(`uploaded ${objectKey(id, zipName)}`);
}
log(`done: Electron ${id}`);
