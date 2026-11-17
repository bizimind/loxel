/**
 * How the `loxel` CLI finds the Loxel server: on the server's Unix socket, which only the user's
 * own account can open (see src/server/cli-socket.ts). Servers from before the socket are still
 * found on their loopback port, for one release. See docs/TERMINALS.md#the-loxel-cli.
 */
import { statSync } from "node:fs";
import { dirname } from "node:path";

import { DEFAULT_SERVER_PORT } from "./app-ports";
import { cliSocketPath } from "./socket-paths";
import { DEFAULT_STATE_DIR } from "./state-dir";

type Env = Record<string, string | undefined>;

/** Where a server answers: a base URL, and the Unix socket to send requests over, if any. */
export interface ServerAddress {
  url: string;
  unix?: string;
}

/** A server to talk to, and whether the environment named it rather than the CLI finding it up. */
export interface FoundServer {
  address: ServerAddress;
  /** From a Loxel terminal's environment: it may be restarting, and is not launched or focused. */
  given: boolean;
}

interface FindOptions {
  /** Ports of servers from before the socket, probed in order; tests pass their own. */
  legacyPorts?: readonly number[];
}

const LEGACY_PORTS = [DEFAULT_SERVER_PORT.production, DEFAULT_SERVER_PORT.dev];
const PROBE_TIMEOUT_MS = 1000;
const WAIT_INTERVAL_MS = 200;

/** On a socket the path is the address; the host only fills the URL. */
const socketAddress = (path: string): ServerAddress => ({ url: "http://localhost", unix: path });
const portAddress = (port: number): ServerAddress => ({ url: `http://127.0.0.1:${port}` });

/**
 * The sockets a server for this user may be on, in the order to try: `LOXEL_STATE_DIR`'s, else
 * production's, then dev's. A Loxel terminal names its server's in `LOXEL_SOCKET`, but terminals
 * outlive servers, so a shell's may be stale.
 */
export function wellKnownSockets(env: Env): string[] {
  if (env.LOXEL_STATE_DIR) return [cliSocketPath(env.LOXEL_STATE_DIR)];
  return [cliSocketPath(DEFAULT_STATE_DIR.production), cliSocketPath(DEFAULT_STATE_DIR.dev)];
}

/** Why the socket at `path` cannot be opened from here, or null when nothing listens there. */
function blockedReason(err: unknown, path: string): string | null {
  const code = err instanceof Error && "code" in err ? err.code : undefined;
  // The socket and its directory are the user's own, with no access for anyone else.
  if (code === "EACCES") return `the Loxel server at ${path} runs as another user`;
  // A sandbox's own rules deny it, which no file mode does.
  if (code === "EPERM") return outsideSandbox(path);
  return null;
}

function outsideSandbox(path: string): string {
  return `Loxel's socket ${path} is outside this sandbox: allow it in the sandbox's settings`;
}

type Probe = { state: "up" } | { state: "down" } | { state: "blocked"; reason: string };

/** Whether a Loxel server answers at `address`. One shutting down does not count: its replacement is the one to talk to. */
async function probe(address: ServerAddress): Promise<Probe> {
  try {
    const res = await fetch(`${address.url}/api/version`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      ...(address.unix ? { unix: address.unix } : {}),
    });
    if (!res.ok) return { state: "down" };
    const body: unknown = await res.json().catch(() => null);
    const shuttingDown =
      typeof body === "object" && body !== null && "shuttingDown" in body && body.shuttingDown;
    return shuttingDown === true ? { state: "down" } : { state: "up" };
  } catch (err) {
    const reason = address.unix ? blockedReason(err, address.unix) : null;
    return reason ? { state: "blocked", reason } : { state: "down" };
  }
}

/**
 * The first server that answers on a well-known socket; else, from before the socket, the one at
 * `terminalPort` (a Loxel terminal's `LOXEL_PORT`, taken as given) or the first to answer on a
 * legacy port. Null when none does. Throws when a socket cannot be opened from here, saying why,
 * since launching Loxel would not help.
 */
async function locate(
  env: Env,
  legacyPorts: readonly number[],
  terminalPort: number | null,
): Promise<FoundServer | null> {
  let blocked: string | null = null;
  for (const path of wellKnownSockets(env)) {
    const address = socketAddress(path);
    const result = await probe(address);
    if (result.state === "up") return { address, given: false };
    if (result.state === "blocked") blocked ??= result.reason;
  }
  // Servers from before the socket; remove once every supported server listens on one.
  if (terminalPort) return { address: portAddress(terminalPort), given: true };
  for (const port of legacyPorts) {
    const address = portAddress(port);
    if ((await probe(address)).state === "up") return { address, given: false };
  }
  if (blocked) throw new Error(blocked);
  return null;
}

/**
 * The server to talk to: `LOXEL_SOCKET`'s, else the first found on a well-known socket (see
 * {@link wellKnownSockets}), else, from before the socket, a Loxel terminal's `LOXEL_PORT` or one
 * answering on 7433, then 7434. Null when no server is up. Throws when a socket cannot be opened
 * from here, saying why.
 */
export async function findServer(
  env: Env,
  { legacyPorts = LEGACY_PORTS }: FindOptions = {},
): Promise<FoundServer | null> {
  if (!env.LOXEL_SOCKET) {
    const terminalPort = env.LOXEL === "1" && env.LOXEL_PORT ? Number(env.LOXEL_PORT) : null;
    return locate(env, legacyPorts, terminalPort);
  }
  const path = env.LOXEL_SOCKET;
  try {
    statSync(dirname(path));
  } catch (err) {
    // The server makes the socket's directory before any terminal starts: if this process cannot
    // see it, the path is another user's, or outside its sandbox or container.
    throw new Error(blockedReason(err, path) ?? outsideSandbox(path), { cause: err });
  }
  const result = await probe(socketAddress(path));
  if (result.state === "blocked") throw new Error(result.reason);
  // Down is fine: the server may be restarting, and opens retry until it is back.
  return { address: socketAddress(path), given: true };
}

/** Wait for a server Loxel is launching to answer, on its socket or, for older ones, its port. */
export async function waitForServer(
  env: Env,
  { legacyPorts = LEGACY_PORTS, timeoutMs = 15_000 }: FindOptions & { timeoutMs?: number } = {},
): Promise<ServerAddress> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await locate(env, legacyPorts, null);
    if (found) return found.address;
    await Bun.sleep(WAIT_INTERVAL_MS);
  }
  throw new Error(`Loxel server did not start within ${timeoutMs / 1000}s`);
}
