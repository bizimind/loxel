/**
 * The terminal host protocol version this build speaks: the single source of it. The protocol
 * (src/terminal-host/protocol.ts) sends it in the handshake, the app updater compares an update's
 * version with it, and the release workflow writes it into the release manifest. It imports
 * nothing, so all three can read it, the workflow with no dependencies installed. See
 * docs/TERMINAL_HOST.md#versioning.
 */

/**
 * As semver. A major bump for any change an older peer would misread; a minor one for a new
 * capability; a patch for a fix that changes no message.
 */
export const TERMINAL_HOST_PROTOCOL = "1.2.0";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** The major version of a protocol version, or null when it is not semver. */
export function protocolMajor(version: string): number | null {
  const major = SEMVER.exec(version)?.[1];
  return major === undefined ? null : Number(major);
}
