/**
 * The terminal hosts a real server under `stateDir` started, for the tests and scripts that run one:
 * hosts outlive their server by design, so whatever started the server ends them afterwards.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { HostEntrySchema, hostRunDir, signalHost } from "@/terminal-host/host-files";

/** The PIDs in the hosts' entries; an entry that is unreadable or half-written is skipped. */
export function hostPids(stateDir: string): number[] {
  const runDir = hostRunDir(stateDir);
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      try {
        const parsed = HostEntrySchema.safeParse(
          JSON.parse(readFileSync(path.join(runDir, name), "utf8")),
        );
        return parsed.success ? [parsed.data.pid] : [];
      } catch {
        return [];
      }
    });
}

/** End every host the server under `stateDir` started, and with it whatever still runs there. */
export function stopHosts(stateDir: string): void {
  for (const pid of hostPids(stateDir)) signalHost(pid);
}
