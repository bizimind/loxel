/**
 * How the `loxel` CLI finds the Loxel server: on the server's Unix socket, which only the user's
 * own account can open (see src/server/cli-socket.ts). Servers from before the socket are still
 * found on their loopback port, for one release. See docs/TERMINALS.md#the-loxel-cli.
 */
import { statSync } from "node:fs";
import { dirname, join } from "node:path";

import { DEFAULT_SERVER_PORT } from "./app-ports";
import { demoPort, demoStateName } from "./demo-instance";
import { cliSocketPath } from "./socket-paths";
import { DEFAULT_STATE_DIR, STATE_BASE_DIR } from "./state-dir";

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

/**
 * The socket of the server a Loxel terminal from before the socket belongs to, which knows its
 * server only by `LOXEL_PORT`: `LOXEL_STATE_DIR`'s if the terminal inherited one, else that of the
 * mode the port is the well-known port of. Null for any other port.
 */
export function terminalSocket(env: Env, port: number): string | null {
  if (env.LOXEL_STATE_DIR) return cliSocketPath(env.LOXEL_STATE_DIR);
  if (port === DEFAULT_SERVER_PORT.production) return cliSocketPath(DEFAULT_STATE_DIR.production);
  if (port === DEFAULT_SERVER_PORT.dev) return cliSocketPath(DEFAULT_STATE_DIR.dev);
  const demoInstance = port - demoPort(0);
  if (demoInstance < 0) return null;
  return cliSocketPath(join(STATE_BASE_DIR, demoStateName(demoInstance)));
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

/**
 * Whether a Loxel server answers at `address`. One shutting down does not count: its replacement
 * is the one to talk to.
 */
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
 * The first server that answers on a well-known socket, else, from before the socket, on a legacy
 * port. Null when none does. Throws when a socket cannot be opened from here, saying why, since
 * launching Loxel would not help.
 */
async function locate(env: Env, legacyPorts: readonly number[]): Promise<ServerAddress | null> {
  let blocked: string | null = null;
  for (const path of wellKnownSockets(env)) {
    const address = socketAddress(path);
    const result = await probe(address);
    if (result.state === "up") return address;
    if (result.state === "blocked") blocked ??= result.reason;
  }
  // Servers from before the socket; remove once every supported server listens on one.
  for (const port of legacyPorts) {
    const address = portAddress(port);
    if ((await probe(address)).state === "up") return address;
  }
  if (blocked) throw new Error(blocked);
  return null;
}

/** `LOXEL_SOCKET`'s server, as given: it may be restarting, and opens retry until it is back. */
async function givenSocket(path: string): Promise<FoundServer> {
  try {
    statSync(dirname(path));
  } catch (err) {
    // The server makes the socket's directory before any terminal starts: one this process cannot
    // see is another user's, outside its sandbox or container, or gone.
    const reason =
      blockedReason(err, path) ??
      `cannot find Loxel's socket ${path}: if this runs in a sandbox, allow the path in its settings`;
    throw new Error(reason, { cause: err });
  }
  const result = await probe(socketAddress(path));
  if (result.state === "blocked") throw new Error(result.reason);
  return { address: socketAddress(path), given: true };
}

/**
 * The server of a Loxel terminal from before the socket (`LOXEL_PORT`), as given: the one that now
 * answers on its mode's socket, as after an update, else the one on its port, which may be
 * restarting. Never another mode's.
 */
async function terminalServer(env: Env, port: number): Promise<FoundServer> {
  const socket = terminalSocket(env, port);
  if (socket) {
    const result = await probe(socketAddress(socket));
    if (result.state === "up") return { address: socketAddress(socket), given: true };
    if (result.state === "blocked") throw new Error(result.reason);
  }
  return { address: portAddress(port), given: true };
}

/**
 * The server to talk to: `LOXEL_SOCKET`'s; else a Loxel terminal's from before the socket (see
 * {@link terminalServer}); else the first found on a well-known socket (see
 * {@link wellKnownSockets}) or, from before the socket, on 7433, then 7434. Null when no server is
 * up. Throws when a socket cannot be opened from here, saying why.
 */
export async function findServer(
  env: Env,
  { legacyPorts = LEGACY_PORTS }: FindOptions = {},
): Promise<FoundServer | null> {
  if (env.LOXEL_SOCKET) return givenSocket(env.LOXEL_SOCKET);
  const terminalPort = env.LOXEL === "1" ? Number(env.LOXEL_PORT) : Number.NaN;
  if (Number.isInteger(terminalPort) && terminalPort > 0) return terminalServer(env, terminalPort);
  const address = await locate(env, legacyPorts);
  return address ? { address, given: false } : null;
}

/** Wait for a server Loxel is launching to answer, on its socket or, for older ones, its port. */
export async function waitForServer(
  env: Env,
  { legacyPorts = LEGACY_PORTS, timeoutMs = 15_000 }: FindOptions & { timeoutMs?: number } = {},
): Promise<ServerAddress> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const address = await locate(env, legacyPorts);
    if (address) return address;
    await Bun.sleep(WAIT_INTERVAL_MS);
  }
  throw new Error(`Loxel server did not start within ${timeoutMs / 1000}s`);
}
