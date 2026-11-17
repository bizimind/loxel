/**
 * Package the standalone server bundle for this machine's platform, from what
 * `pnpm run build:server:standalone` and `pnpm exec vite build` built:
 *
 *   bun scripts/build-server-bundle.ts   # release/server/loxel-server-<version>-<platform>.tar.gz
 *
 * The bundle is laid out as the server finds its resources: the terminal host and every language
 * server beside `loxel-server` (as in the app's Resources), and the renderer in `renderer/`, which a
 * compiled server serves when `LOXEL_STATIC_DIR` is unset. Loxel's license and the language
 * servers' notices go in `LICENSE` and `licenses/`. The server, the terminal host and the language
 * servers are all built for the machine they build on, so each platform builds on its own runner.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { $ } from "bun";
import { z } from "zod";

import { TERMINAL_HOST_BINARY } from "../src/terminal-host/host-files";
import { STAGE_DIR } from "./language-server-binaries";
import { MANIFEST_DIR, readManifests, shippedComponent } from "./language-server-manifest";

const packageRoot = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const OUT_DIR = path.join(packageRoot, "release", "server");

/** Copy `from` to `to`, failing when it was never built. Symlinks are kept as they are. */
function copyBuilt(from: string, to: string, filter?: (source: string) => boolean): void {
  if (!existsSync(from)) throw new Error(`Missing ${from}: build it first (see this script's doc)`);
  cpSync(from, to, { recursive: true, verbatimSymlinks: true, filter });
}

/** `licenses/`: each language server's license file, and a list of what each one is under. */
async function writeNotices(bundleDir: string): Promise<void> {
  const licensesDir = path.join(bundleDir, "licenses");
  mkdirSync(licensesDir);
  const lines = [
    "# Third-party language servers",
    "",
    "The language servers beside `loxel-server` whose manifests name a license, each under its own:",
    "",
  ];
  for (const manifest of await readManifests()) {
    // Its license and source, with the manifest's version in place of `{version}`.
    const shipped = shippedComponent(manifest);
    if (!shipped) continue;
    lines.push(`- ${manifest.name}: ${shipped.license}`);
    if (shipped.source) lines.push(`  Source: ${shipped.source}`);
    if (manifest.note) lines.push(`  ${manifest.note}`);
    if (manifest.licenseFile) {
      const licenseFile = `${manifest.name}.txt`;
      copyBuilt(path.join(MANIFEST_DIR, manifest.licenseFile), path.join(licensesDir, licenseFile));
      lines.push(`  License: ${licenseFile}`);
    }
  }
  await Bun.write(path.join(licensesDir, "README.md"), `${lines.join("\n")}\n`);
}

const { version } = z
  .object({ version: z.string() })
  .parse(await Bun.file(path.join(packageRoot, "package.json")).json());
const platform = `${process.platform}-${process.arch}`;
const name = `loxel-server-${version}-${platform}`;
const bundleDir = path.join(OUT_DIR, name);

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(bundleDir, { recursive: true });
copyBuilt(path.join(packageRoot, "build", "loxel-server"), path.join(bundleDir, "loxel-server"));
copyBuilt(
  path.join(packageRoot, "build", TERMINAL_HOST_BINARY),
  path.join(bundleDir, TERMINAL_HOST_BINARY),
);
copyBuilt(STAGE_DIR, bundleDir);
// `pnpm run build` also writes the server's JS bundle into dist/server/, which is not the renderer.
const distDir = path.join(packageRoot, "dist");
copyBuilt(distDir, path.join(bundleDir, "renderer"), (source) => {
  return source !== path.join(distDir, "server");
});
copyBuilt(path.join(repoRoot, "LICENSE"), path.join(bundleDir, "LICENSE"));
await writeNotices(bundleDir);

// Owned by root in the tarball rather than by the CI runner's user, whose ID may be a real user's
// where it is extracted as root. GNU tar only; a Mac's tar, for trying this locally, keeps yours.
const ownership = process.platform === "linux" ? ["--owner=0", "--group=0", "--numeric-owner"] : [];
await $`tar ${ownership} -czf ${`${name}.tar.gz`} ${name}`.cwd(OUT_DIR);
console.log(`[build-server-bundle] ${path.join(OUT_DIR, `${name}.tar.gz`)}`);
