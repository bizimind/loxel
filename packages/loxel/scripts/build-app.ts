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
 */
import fs from "node:fs";
import path from "node:path";

import { $ } from "bun";

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

await $`pnpm exec electron-builder ${args}`.cwd(packageRoot);
