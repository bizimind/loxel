import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ServerIdentity } from "@/api/ws-protocol";

import { config } from "./config";

const SERVER_ID_PATTERN = /^[0-9a-f-]{36}$/;

/**
 * The server ID stored in `<stateDir>/server-id`, created on first use. Read synchronously once
 * at startup, so every later read is free. An unreadable or malformed file is replaced.
 */
export function loadServerId(stateDir: string): string {
  const file = join(stateDir, "server-id");
  const stored = readServerId(file);
  if (stored) return stored;

  const serverId = randomUUID();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${serverId}\n`);
  return serverId;
}

function readServerId(file: string): string | null {
  try {
    const value = readFileSync(file, "utf8").trim();
    return SERVER_ID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** This server's identity: its persisted ID and the epoch of this process. */
export const serverIdentity: ServerIdentity = {
  serverId: loadServerId(config.stateDir),
  bootEpoch: randomUUID(),
};
