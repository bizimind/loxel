/**
 * Local macOS app build. Embeds a Developer ID provisioning profile when one is
 * present at build/embedded.provisionprofile so passkeys work in the result;
 * otherwise signs with the unprovisioned entitlements, which macOS accepts
 * without a profile but which leave passkeys disabled.
 */
import fs from "node:fs";
import path from "node:path";

import { $ } from "bun";

const packageRoot = path.resolve(import.meta.dirname, "..");
const profile = path.join(packageRoot, "build", "embedded.provisionprofile");

const args = ["--mac", "--dir", "--arm64"];
if (fs.existsSync(profile)) {
  console.log(`[build-app-local] embedding provisioning profile ${profile}`);
  args.push(`--config.mac.provisioningProfile=${profile}`);
} else {
  console.log("[build-app-local] no build/embedded.provisionprofile; passkeys will be disabled");
  args.push("--config.mac.entitlements=assets/entitlements.mac.unprovisioned.plist");
}

await $`pnpm exec electron-builder ${args}`.cwd(packageRoot);
