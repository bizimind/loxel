/**
 * Signs a CLI release binary with the Developer ID in the keychain, checks it satisfies the
 * requirement installed binaries check updates against, and that it still runs under the hardened
 * runtime. Run by the release workflows on macOS.
 *
 * Usage: bun packages/cli-common/scripts/codesign-release.ts <binary> <package-name>
 */
import path from "node:path";

import {
  CODESIGN,
  codeSigningIdentifier,
  verifyCodeSignature,
} from "../src/update/code-signature.ts";

const [binary, packageName] = process.argv.slice(2);
if (!binary || !packageName) {
  throw new Error("Usage: codesign-release.ts <binary> <package-name>");
}

async function run(cmd: string[]): Promise<void> {
  const exitCode = await Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" }).exited;
  if (exitCode !== 0) throw new Error(`${cmd.join(" ")} exited with ${exitCode}`);
}

await run([
  CODESIGN,
  "--force",
  "--sign",
  "Developer ID Application",
  "--identifier",
  codeSigningIdentifier(packageName),
  "--options",
  "runtime",
  "--entitlements",
  path.join(import.meta.dir, "..", "entitlements.mac.plist"),
  "--timestamp",
  binary,
]);
await verifyCodeSignature(binary, packageName);
await run([binary, "--version"]);
