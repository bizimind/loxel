/**
 * Builds the ESLint language server from microsoft/vscode-eslint into one JS file,
 * `build/eslint-language-server/eslintServer.cjs`, which Loxel runs under the user's Node. The
 * extension publishes no package of its server, so the source comes from its release tag, pinned
 * by SHA256 and hashed in memory before anything is extracted, with its npm dependencies pinned in
 * package.json to the versions that tag names in `server/package.json`.
 *
 * Not compiled with `bun build --compile`: the server resolves ESLint by forking `process.execPath`
 * and loads project files from disk, and neither works from a compiled binary.
 *
 * To upgrade: change the tag and hash, and the devDependencies to match its `server/package.json`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { BUILD_DIR } from "./download-release-binary";

const TAG = "release/3.0.34";
const SHA256 = "f82fb2aab96eede6273af2d9aafeb9a29c5723c5af5a9819e37c61d7f51cc052";
const URL = `https://codeload.github.com/microsoft/vscode-eslint/tar.gz/refs/tags/${TAG}`;
const ARCHIVE_ROOT = `vscode-eslint-${TAG.replace("/", "-")}`;

// Under `build/`, so that imports resolve from this package's node_modules.
const SOURCE_DIR = path.join(BUILD_DIR, "eslint-language-server-source", SHA256);
const OUT_DIR = path.join(BUILD_DIR, "eslint-language-server");

async function fetchSource(): Promise<void> {
  if (existsSync(path.join(SOURCE_DIR, "server/src/eslintServer.ts"))) return;

  console.log(`Downloading ${URL}`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== SHA256) throw new Error(`SHA256 mismatch: expected ${SHA256}, got ${actual}`);

  rmSync(SOURCE_DIR, { recursive: true, force: true });
  mkdirSync(SOURCE_DIR, { recursive: true });
  const tar = Bun.spawn(
    [
      "tar",
      "xzf",
      "-",
      "-C",
      SOURCE_DIR,
      "--strip-components=1",
      `${ARCHIVE_ROOT}/server/src`,
      `${ARCHIVE_ROOT}/$shared`,
    ],
    { stdin: bytes, stdout: "inherit", stderr: "inherit" },
  );
  if ((await tar.exited) !== 0) throw new Error("Could not extract the server's source");
}

await fetchSource();

const result = await Bun.build({
  entrypoints: [path.join(SOURCE_DIR, "server/src/eslintServer.ts")],
  target: "node",
  format: "cjs",
  outdir: OUT_DIR,
  naming: "[name].cjs",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("Bundling the ESLint language server failed");
}
console.log(`Built: ${path.join(OUT_DIR, "eslintServer.cjs")}`);
