/**
 * The notice for terminal hosts the server ended at startup because it cannot talk to them (after
 * a downgrade, or an update whose release did not say which protocol it speaks): the terminals in
 * them are gone, and the user hears it rather than finding fresh shells.
 */
import type { EndedHost } from "@/terminal-host";

export interface EndedHostsNotice {
  title: string;
  body: string;
}

/** The notice for `ended`, or null when no terminal ended. */
export function endedHostsNotice(ended: readonly EndedHost[]): EndedHostsNotice | null {
  if (ended.length === 0) return null;
  // A 1.0.0 host does not say how many sessions it ran, so the count is only given when all did.
  const counted = ended.every((host) => host.sessions !== null);
  const count = ended.reduce((sum, host) => sum + (host.sessions ?? 0), 0);
  if (counted && count === 0) return null;
  const protocols = [...new Set(ended.map((host) => host.protocol))].join(", ");
  const title = !counted
    ? "Terminals were ended (incompatible terminal host)"
    : count === 1
      ? "1 terminal was ended (incompatible terminal host)"
      : `${count} terminals were ended (incompatible terminal host)`;
  return {
    title,
    body: `They ran in a terminal host this version of Loxel cannot talk to (protocol ${protocols}).`,
  };
}
