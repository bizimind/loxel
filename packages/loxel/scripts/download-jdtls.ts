/**
 * Downloads Eclipse JDT LS into `packages/loxel/build/jdtls/`. It is one archive for every
 * platform, shipped as released. It runs on the user's JDK.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import { BUILD_DIR } from "./download-release-binary";
import { manifestFile, manifestTargets, manifestVersion } from "./language-server-manifest";

const VERSION = await manifestVersion("jdtls");
// `language-servers/jdtls.json` pins the release's one archive, whose name carries a build
// timestamp; pin-hashes.ts finds it from the release's `latest.txt`.
const [ARCHIVE = ""] = await manifestTargets("jdtls");
if (!ARCHIVE.startsWith(`jdt-language-server-${VERSION}-`)) {
  throw new Error(
    `jdtls.json pins ${ARCHIVE}, not an archive of ${VERSION}; ` +
      "run `pnpm -C packages/loxel run pin-hashes jdtls`",
  );
}
const { url, sha256: SHA256 } = await manifestFile("jdtls", ARCHIVE);

const outDir = path.join(BUILD_DIR, "jdtls");
const versionFile = `${outDir}.version`;

if (
  existsSync(outDir) &&
  existsSync(versionFile) &&
  (await Bun.file(versionFile).text()) === VERSION
) {
  console.log(`jdtls ${VERSION} already present at ${outDir}, skipping download`);
  process.exit(0);
}

console.log(`Downloading ${url}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
const bytes = new Uint8Array(await res.arrayBuffer());
const actualHash = createHash("sha256").update(bytes).digest("hex");
if (actualHash !== SHA256) {
  throw new Error(`SHA256 mismatch!\n  expected: ${SHA256}\n  actual:   ${actualHash}`);
}

mkdirSync(BUILD_DIR, { recursive: true });
const scratch = mkdtempSync(path.join(BUILD_DIR, "jdtls-download-"));
try {
  const archivePath = path.join(scratch, ARCHIVE);
  await Bun.write(archivePath, bytes);
  const extracted = path.join(scratch, "jdtls");
  await Bun.$`mkdir ${extracted} && tar -xf ${archivePath} -C ${extracted}`;
  // The archive has no top-level notices; each plugin carries its own.
  copyFileSync(
    path.join(import.meta.dir, "language-servers", "licenses", "jdtls.txt"),
    path.join(extracted, "LICENSE"),
  );
  await Bun.write(
    path.join(extracted, "NOTICE"),
    `Eclipse JDT Language Server ${VERSION}, unmodified, under the Eclipse Public License 2.0 (LICENSE).\nSource: https://github.com/eclipse-jdtls/eclipse.jdt.ls/tree/v${VERSION}\nEach plugin in plugins/ carries its own notices and license.\n`,
  );
  rmSync(outDir, { recursive: true, force: true });
  renameSync(extracted, outDir);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
await Bun.write(versionFile, VERSION);
console.log(`Installed: ${outDir}`);
