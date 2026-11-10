/**
 * Package the macOS app with electron-builder. Any arguments are passed through
 * as electron-builder target flags (none means the targets in electron-builder.yml).
 *
 * The entitlements in assets/entitlements.mac.plist include the restricted
 * keychain access group passkeys need, which macOS honours only when a Developer
 * ID provisioning profile is embedded. With build/embedded.provisionprofile
 * present it is embedded; otherwise the app is signed with the unprovisioned
 * entitlements so it still launches, with passkeys disabled. The release
 * workflow passes --config.mac.provisioningProfile explicitly instead.
 *
 * Releases ship a patched Electron (docs/PATCHED_ELECTRON.md). When `fetch-electron.ts` or
 * `build-electron.ts` has put the zip for the target architecture in build/electron-dist, it is
 * packaged; otherwise the app gets stock Electron from node_modules, without the patches.
 */
import fs from "node:fs";
import path from "node:path";

import { $ } from "bun";

import { DIST_DIR, currentBuild, distZipName, parseArch } from "./electron-dist";

const packageRoot = path.resolve(import.meta.dirname, "..");
const profile = path.join(packageRoot, "build", "embedded.provisionprofile");

const args = Bun.argv.slice(2);
if (args.some((arg) => arg.startsWith("--config.mac.provisioningProfile"))) {
  console.log("[build-app] using the provisioning profile given on the command line");
} else if (fs.existsSync(profile)) {
  console.log(`[build-app] embedding provisioning profile ${profile}`);
  args.push(`--config.mac.provisioningProfile=${profile}`);
} else {
  console.log("[build-app] no build/embedded.provisionprofile; passkeys will be disabled");
  args.push("--config.mac.entitlements=assets/entitlements.mac.unprovisioned.plist");
}

const arch = parseArch(
  args.includes("--x64") ? "x64" : args.includes("--arm64") ? "arm64" : process.arch,
);
const patchedZip = path.join(DIST_DIR, distZipName(currentBuild().version, arch));
if (args.some((arg) => arg.startsWith("--config.electronDist"))) {
  console.log("[build-app] using the Electron given on the command line");
} else if (fs.existsSync(patchedZip)) {
  console.log(`[build-app] packaging patched Electron ${patchedZip}`);
  args.push(`--config.electronDist=${DIST_DIR}`);
} else {
  console.log("[build-app] no patched Electron in build/electron-dist; packaging stock Electron");
}

await $`pnpm exec electron-builder ${args}`.cwd(packageRoot);
