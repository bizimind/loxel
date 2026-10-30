/**
 * Links the Java runtime JDT LS runs on into `packages/loxel/build/jdtls-runtime/`, from the Temurin
 * JDK of this machine's platform. jlink links from the JDK's own runtime image (Temurin has no
 * `jmods/`), so it cannot build for another platform: each release runner builds its own.
 *
 * JDT LS needs Java 25, whatever its launcher script says. It does not start without
 * `java.desktop`: its bundles import `java.beans`.
 */

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import { BUILD_DIR, downloadVerified } from "./download-release-binary";

const VERSION = "25.0.5+8";
const MODULES = [
  "java.base",
  "java.compiler",
  "java.datatransfer",
  "java.desktop",
  "java.instrument",
  "java.logging",
  "java.management",
  "java.naming",
  "java.net.http",
  "java.prefs",
  "java.rmi",
  "java.scripting",
  "java.security.jgss",
  "java.security.sasl",
  "java.sql",
  "java.xml",
  "java.xml.crypto",
  "jdk.charsets",
  "jdk.crypto.ec",
  "jdk.management",
  "jdk.net",
  "jdk.unsupported",
  "jdk.zipfs",
];

/** Pinned SHA256 digests of the JDK archives from the jdk-25.0.5+8 release, by platform. */
const SHA256: Record<string, string> = {
  aarch64_mac: "36dc14d797aaff6d89aab302cd053fdba6207dfdcf772052fa7b023a94b0e857",
  x64_mac: "32cd4d2151c91aa00d0fc911edfd05245ed40fa6b1aa894d5f35c928cd67a59d",
  x64_linux: "68982529869257d0ee6b824ec5aa270ff8b118bb438670da0b97ebdab178d7fb",
  aarch64_linux: "bb5b2ded252f21c6090cf780b0a408ad0d83bbb557e702955643557f13231880",
  x64_windows: "636bdc13dc649ddc7d5921c5c7d23cca6e44fd19d662b45cc9c02135a6c96c42",
};

const OS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "mac",
  linux: "linux",
  win32: "windows",
};
const platform = `${process.arch === "arm64" ? "aarch64" : "x64"}_${OS[process.platform]}`;
const sha256 = SHA256[platform];
if (!sha256) {
  console.error(`No pinned SHA256 for platform ${platform}`);
  process.exit(1);
}

const isWindows = process.platform === "win32";
const outDir = path.join(BUILD_DIR, "jdtls-runtime");
const versionFile = `${outDir}.version`;

if (existsSync(versionFile) && (await Bun.file(versionFile).text()) === VERSION) {
  console.log(`Java runtime ${VERSION} already present at ${outDir}, skipping build`);
  process.exit(0);
}

const archive = `OpenJDK25U-jdk_${platform}_hotspot_${VERSION.replace("+", "_")}.${isWindows ? "zip" : "tar.gz"}`;
const bytes = await downloadVerified(
  `https://github.com/adoptium/temurin25-binaries/releases/download/jdk-${encodeURIComponent(VERSION)}/${archive}`,
  sha256,
);

mkdirSync(BUILD_DIR, { recursive: true });
const scratch = mkdtempSync(path.join(BUILD_DIR, "jdtls-runtime-build-"));
try {
  const archivePath = path.join(scratch, archive);
  await Bun.write(archivePath, bytes);
  // bsdtar (macOS, Windows) reads zips too; GNU tar on Linux only gets tarballs.
  await Bun.$`tar -xf ${archivePath} -C ${scratch}`;
  const jdkRoot = path.join(scratch, `jdk-${VERSION}`);
  const jdkHome = process.platform === "darwin" ? path.join(jdkRoot, "Contents", "Home") : jdkRoot;
  const linked = path.join(scratch, "jdtls-runtime");
  await Bun.$`${path.join(jdkHome, "bin", isWindows ? "jlink.exe" : "jlink")} --add-modules ${MODULES.join(",")} --strip-debug --no-header-files --no-man-pages --compress zip-6 --output ${linked}`;
  // Only `java` runs. These come with their modules.
  for (const tool of ["jrunscript", "keytool", "rmiregistry"]) {
    rmSync(path.join(linked, "bin", isWindows ? `${tool}.exe` : tool), { force: true });
  }
  rmSync(outDir, { recursive: true, force: true });
  renameSync(linked, outDir);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
await Bun.write(versionFile, VERSION);
console.log(`Installed: ${outDir}`);
