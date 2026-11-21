/**
 * Build Loxel's patched Electron on a Mac and upload it to R2 for the release workflow:
 *
 *   pnpm run build:electron [-- --arch arm64 --arch x64] [--root <dir>] [--no-upload] [--force]
 *   pnpm run build:electron -- --testing [--root <dir>]
 *
 * Checks out the Electron release package.json pins, applies the `.patch` files in
 * `electron/patches/` in numeric order, and builds Electron's release configuration for each
 * architecture (x64 is cross-compiled on Apple silicon). Each zip is checked for the right version
 * and architecture, kept under its build ID, copied to build/electron-dist for local packaging, and
 * uploaded. A build already in R2 is skipped, and one already built for this ID (e.g. by a
 * --no-upload run) is only uploaded, unless --force.
 *
 * `--testing` builds Electron's `testing` configuration for this Mac's architecture only, into its
 * own output directory, incrementally and without uploading, and prints the
 * ELECTRON_OVERRIDE_DIST_PATH to run Loxel on it. A checkout left as it was prepared for this
 * build ID isn't checked out, patched or synced again (--force redoes it).
 *
 * Needs Electron's build tools (`npm i -g @electron/build-tools`), Xcode with its Metal toolchain,
 * about 150 GB of disk, and the R2 credentials fetch-electron.ts uses. See
 * docs/PATCHED_ELECTRON.md.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    testing: { type: "boolean", default: false },
  },
});

const testing = values.testing;
if (testing && values.arch) throw new Error("--testing builds this Mac's architecture only");
const arches: ElectronArch[] = testing
  ? [parseArch(process.arch)]
  : (values.arch?.map(parseArch) ?? [...ELECTRON_ARCHES]);
const root = path.resolve(
  values.root ??
    process.env.LOXEL_ELECTRON_ROOT ??
    path.join(os.homedir(), "git", "open-source", "electron-loxel"),
);
const upload = !values["no-upload"] && !testing;
const { version, id } = currentBuild();
const tag = `v${version}`;
const log = (message: string) => console.log(`[build-electron] ${message}`);

/**
 * One build-tools config per configuration and architecture, sharing the checkout under `root`
 * and each building into its own output directory.
 */
const buildConfig = testing ? "testing" : "release";
const configName = (arch: ElectronArch) => `loxel-${buildConfig}-${arch}`;
const outDir = (arch: ElectronArch) => `${testing ? "Testing" : "Release"}-${arch}`;

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
 * Create the arch's build-tools config on first use. It, or an existing one, must build the checkout
 * under `root`: one made for another root would build there while the patches go here, and the zip read
 * back from here would be an older build.
 */
async function ensureConfig(arch: ElectronArch): Promise<void> {
  const hasConfig = async () =>
    (await $`e show configs`.nothrow().quiet().text()).split(/\s+/).includes(configName(arch));
  if (!(await hasConfig())) {
    log(`creating build config ${configName(arch)} in ${root}`);
    // `e init` writes the config, then refuses a root that holds a checkout already (another
    // config's), which this shared checkout does; the config it wrote is what's needed.
    const init =
      await $`e init ${configName(arch)} --root ${root} --import ${buildConfig} --out ${outDir(arch)} --target-cpu ${arch} --remote-build none --use-https`.nothrow();
    if (init.exitCode !== 0 && !(await hasConfig())) {
      throw new Error(
        `Could not create build config ${configName(arch)}: ${init.stderr.toString()}`,
      );
    }
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

/**
 * What a testing checkout was last prepared for: the tag it synced, and once patched, the build ID
 * and the commit that left it at. Release builds always prepare from scratch.
 */
const preparedMarker = path.join(root, "loxel-prepared.json");

interface Prepared {
  tag?: unknown;
  id?: unknown;
  head?: unknown;
}

function readPrepared(): Prepared {
  try {
    const parsed: unknown = JSON.parse(readFileSync(preparedMarker, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

const writePrepared = (prepared: Prepared) =>
  Bun.write(preparedMarker, `${JSON.stringify(prepared)}\n`);

/** Paths a patch can change that `e sync` reads: Chromium's patches, DEPS, the npm deps. */
const SYNC_INPUTS = /^diff --git a\/(?:patches\/|DEPS |package\.json |yarn\.lock )/m;

/** The checkout's commit, and whether it has changes or untracked files (or git failed). */
async function checkoutState(dir: string): Promise<{ head: string; dirty: boolean }> {
  const status = await $`git status --porcelain --untracked-files=normal`
    .cwd(dir)
    .nothrow()
    .quiet();
  const head = await $`git rev-parse HEAD`.cwd(dir).nothrow().quiet();
  return {
    head: head.text().trim(),
    dirty: status.exitCode !== 0 || head.exitCode !== 0 || status.text().trim() !== "",
  };
}

/**
 * Check out the pinned release with the patches on top, and sync its dependencies. Uncommitted
 * changes in the Electron checkout stop it, unless --force discards them.
 *
 * For --testing, a checkout left exactly as it was prepared for this build ID (same commit, no
 * changes) is used as it is, and one already synced for this tag isn't synced again unless a patch
 * changes what the sync reads, so an incremental build recompiles only what the patches touch.
 */
async function prepareSource(arch: ElectronArch): Promise<void> {
  const electronSrc = path.join(root, "src", "electron");
  await $`e use ${configName(arch)}`;
  const prepared = testing && !values.force ? readPrepared() : {};
  if (existsSync(electronSrc)) {
    const state = await checkoutState(electronSrc);
    if (!state.dirty && prepared.id === id && prepared.head === state.head) {
      log(`checkout already prepared for ${id}`);
      return;
    }
    if (state.dirty && !values.force) {
      throw new Error(
        `${electronSrc} has uncommitted changes or untracked files, which preparing it would ` +
          "discard. Commit or remove them, or pass --force.",
      );
    }
  } else {
    log("first sync: cloning Electron and Chromium (about 30 GB)");
    await $`e sync`;
  }
  // Until the patches apply, the checkout is only known to be synced for its tag.
  await writePrepared(prepared.tag === tag ? { tag } : {});
  await $`git am --abort`.cwd(electronSrc).nothrow().quiet();
  await $`git fetch --no-tags origin refs/tags/${tag}:refs/tags/${tag}`.cwd(electronSrc);
  await $`git checkout --detach --force ${tag}`.cwd(electronSrc);
  log(`applying patches from ${PATCHES_DIR}`);
  const patches = readPatches();
  const patchFiles = patches.map((patch) => path.join(PATCHES_DIR, patch.name));
  await $`git -c user.name=loxel-build -c user.email=loxel-build@invalid am --3way ${patchFiles}`.cwd(
    electronSrc,
  );
  const changesSync = patches.some((patch) =>
    SYNC_INPUTS.test(new TextDecoder().decode(patch.contents)),
  );
  if (prepared.tag === tag && !changesSync) {
    log(`dependencies already synced for ${tag}`);
  } else {
    log(`syncing dependencies for ${tag}`);
    await $`e sync`;
  }
  const head = (await $`git rev-parse HEAD`.cwd(electronSrc).text()).trim();
  await writePrepared({ tag, id, head });
}

/** Check that the app bundle's `Contents` at `app` is the pinned version, built for `arch`. */
async function checkApp(app: string, arch: ElectronArch): Promise<void> {
  const built =
    await $`plutil -extract CFBundleShortVersionString raw ${path.join(app, "Info.plist")}`.text();
  if (built.trim() !== version)
    throw new Error(`Built Electron ${built.trim()}, expected ${version}`);
  const archs = (await $`lipo -archs ${path.join(app, "MacOS", "Electron")}`.text()).trim();
  const expected = arch === "x64" ? "x86_64" : "arm64";
  if (archs !== expected) throw new Error(`Built Electron for ${archs}, expected ${expected}`);
}

/** Build the testing configuration in place, for running Loxel on it. */
async function buildTesting(arch: ElectronArch): Promise<void> {
  await $`e use ${configName(arch)}`;
  log(`building ${tag} darwin-${arch} (testing configuration, incremental)`);
  await $`e build -t electron`;
  const dist = path.join(root, "src", "out", outDir(arch));
  await checkApp(path.join(dist, "Electron.app", "Contents"), arch);
  log(`done: run Loxel on it with ELECTRON_OVERRIDE_DIST_PATH=${dist}`);
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
    await checkApp(path.join(scratch, "Electron.app", "Contents"), arch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return zip;
}

/** Where a checked zip of this build is kept, under its build ID. */
const keptZip = (arch: ElectronArch) =>
  path.join(root, "loxel-dist", id, distZipName(version, arch));

/** Build, check, keep and upload the release zips for `arches`. */
async function buildRelease(): Promise<void> {
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
}

await checkPrerequisites();
if (testing) {
  const arch = arches[0]!;
  await ensureConfig(arch);
  await prepareSource(arch);
  await buildTesting(arch);
} else {
  await buildRelease();
}
