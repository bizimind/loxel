/**
 * What an update does to the running terminals, decided from versions alone. Kept free of Electron
 * so the decisions are testable; app-updater.ts applies them. See docs/ELECTRON.md#updates.
 */
import { TERMINAL_HOST_PROTOCOL, protocolMajor } from "../api/terminal-host-protocol-version";
import type { RestartsTerminals } from "../api/update-model";
import type { ShutdownTerminals } from "../parent-channel-protocol";

/**
 * Whether an update whose terminal hosts speak `updateProtocol` ends the running terminals. They
 * all speak this build's protocol, or a minor version of its major: the server ends hosts of any
 * other major at startup, and starts hosts only of its own build. An update whose release does not
 * say (an older manifest), or says something that is not semver, may or may not.
 */
export function updateRestartsTerminals(
  updateProtocol: string | undefined,
  runningProtocol: string = TERMINAL_HOST_PROTOCOL,
): RestartsTerminals {
  const updateMajor = updateProtocol === undefined ? null : protocolMajor(updateProtocol);
  const runningMajor = protocolMajor(runningProtocol);
  if (updateMajor === null || runningMajor === null) return "unknown";
  return updateMajor !== runningMajor;
}

/**
 * What installing the update tells the server to do with the terminals. An update that restarts
 * them ends them, rather than leaving hosts its server cannot talk to. One that may keeps them:
 * its server adopts the hosts it can talk to and ends the rest, saying so in a notice.
 */
export function terminalsForInstall(restartsTerminals: RestartsTerminals): ShutdownTerminals {
  return restartsTerminals === true ? "end" : "keep";
}
