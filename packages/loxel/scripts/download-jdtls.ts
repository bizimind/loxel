/**
 * Downloads Eclipse JDT LS into `packages/loxel/build/jdtls/`. It is one archive for every
 * platform, shipped as released. The Java it runs on comes from `build-jdtls-runtime.ts`.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import { BUILD_DIR, downloadVerified } from "./download-release-binary";

const VERSION = "1.63.0";
const ARCHIVE = `jdt-language-server-${VERSION}-202610191322.tar.gz`;
const SHA256 = "b1f2abe0b3cccb462cf64fb4a5587c7d09df60cf8be7748b152cbd89d018bdc4";

const outDir = path.join(BUILD_DIR, "jdtls");
const versionFile = `${outDir}.version`;

if (existsSync(versionFile) && (await Bun.file(versionFile).text()) === VERSION) {
  console.log(`jdtls ${VERSION} already present at ${outDir}, skipping download`);
  process.exit(0);
}

const bytes = await downloadVerified(
  `https://download.eclipse.org/jdtls/milestones/${VERSION}/${ARCHIVE}`,
  SHA256,
);

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
