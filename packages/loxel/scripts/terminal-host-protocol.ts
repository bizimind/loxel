/**
 * Print the terminal host protocol this source tree speaks, for the release workflow to write into
 * the release manifest. Reads the single source (src/api/terminal-host-protocol-version.ts), which
 * imports nothing, so it runs without the dependencies installed. Fails rather than print a version
 * that is not semver, so a release never publishes a manifest the updater cannot read.
 *
 * Usage: bun scripts/terminal-host-protocol.ts
 */
import { TERMINAL_HOST_PROTOCOL, protocolMajor } from "../src/api/terminal-host-protocol-version";

if (protocolMajor(TERMINAL_HOST_PROTOCOL) === null) {
  throw new Error(
    `TERMINAL_HOST_PROTOCOL is not semver: ${JSON.stringify(TERMINAL_HOST_PROTOCOL)}`,
  );
}
console.log(TERMINAL_HOST_PROTOCOL);
