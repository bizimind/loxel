#!/usr/bin/env bun
/**
 * Downloads whisper.cpp source at a pinned version.
 * Runs as postinstall to ensure source is available for cmake-js build.
 */

const WHISPER_VERSION = "v1.7.5";
const WHISPER_REPO = "ggerganov/whisper.cpp";
const WHISPER_URL = `https://github.com/${WHISPER_REPO}/archive/refs/tags/${WHISPER_VERSION}.tar.gz`;

const DEPS_DIR = new URL("../deps", import.meta.url).pathname;
const WHISPER_DIR = `${DEPS_DIR}/whisper.cpp`;
const VERSION_FILE = `${WHISPER_DIR}/.downloaded-version`;

async function main() {
  // Check if already downloaded at correct version
  try {
    const currentVersion = await Bun.file(VERSION_FILE).text();
    if (currentVersion.trim() === WHISPER_VERSION) {
      console.log(`whisper.cpp ${WHISPER_VERSION} already downloaded`);
      return;
    }
  } catch {
    // Version file doesn't exist, need to download
  }

  console.log(`Downloading whisper.cpp ${WHISPER_VERSION}...`);

  // Clean existing deps directory
  const rmResult = await Bun.$`rm -rf ${WHISPER_DIR}`.nothrow();
  if (rmResult.exitCode !== 0) {
    throw new Error(
      `Failed to remove existing whisper.cpp directory: ${rmResult.stderr.toString()}`,
    );
  }

  const mkdirResult = await Bun.$`mkdir -p ${DEPS_DIR}`.nothrow();
  if (mkdirResult.exitCode !== 0) {
    throw new Error(
      `Failed to create deps directory ${DEPS_DIR}: ${mkdirResult.stderr.toString()}`,
    );
  }

  // Download and extract tarball
  const response = await fetch(WHISPER_URL, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(
      `Failed to download whisper.cpp from ${WHISPER_URL}: ${response.status} ${response.statusText}`,
    );
  }

  const tarball = await response.arrayBuffer();
  const tarballPath = `${DEPS_DIR}/whisper.cpp.tar.gz`;

  await Bun.write(tarballPath, tarball);

  // Extract tarball
  const tarResult = await Bun.$`tar -xzf ${tarballPath} -C ${DEPS_DIR}`.nothrow();
  if (tarResult.exitCode !== 0) {
    throw new Error(`Failed to extract whisper.cpp tarball: ${tarResult.stderr.toString()}`);
  }

  // Rename extracted directory (it comes as whisper.cpp-{version})
  const extractedDir = `${DEPS_DIR}/whisper.cpp-${WHISPER_VERSION.replace("v", "")}`;
  const mvResult = await Bun.$`mv ${extractedDir} ${WHISPER_DIR}`.nothrow();
  if (mvResult.exitCode !== 0) {
    throw new Error(
      `Failed to move extracted directory from ${extractedDir} to ${WHISPER_DIR}: ${mvResult.stderr.toString()}`,
    );
  }

  // Validate directory exists after move
  const { existsSync } = await import("fs");
  if (!existsSync(WHISPER_DIR)) {
    throw new Error(`whisper.cpp directory does not exist at ${WHISPER_DIR} after extraction`);
  }

  // Clean up tarball (non-critical, just warn on failure)
  const cleanupResult = await Bun.$`rm ${tarballPath}`.nothrow();
  if (cleanupResult.exitCode !== 0) {
    console.warn(
      `Warning: Failed to remove tarball ${tarballPath}: ${cleanupResult.stderr.toString()}`,
    );
  }

  // Write version file
  await Bun.write(VERSION_FILE, WHISPER_VERSION);

  console.log(`whisper.cpp ${WHISPER_VERSION} downloaded successfully`);
}

main().catch((err) => {
  console.error("Failed to download whisper.cpp:", err.message);
  process.exit(1);
});
