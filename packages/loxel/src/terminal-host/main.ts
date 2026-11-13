/**
 * Entry point of `loxel-terminal-host`, the detached process that owns terminal sessions so they
 * outlive the server. Started by host-launcher.ts:
 *
 *   loxel-terminal-host --run-dir <dir> --socket-dir <dir> --host-id <id> --log-file <path>
 *                       [--build-id <id>]
 *
 * It listens on `<socket-dir>/<host-id>.sock`, writes its entry to `<run-dir>/<host-id>.json`, prints `ready` on stdout
 * once both exist, and exits once it has neither a server nor sessions. `--build-id` is for a host
 * run from source; a built host has its ID embedded. See docs/TERMINAL_HOST.md#the-process.
 */
import { chmodSync, closeSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";

import { TERMINAL_HOST_PROTOCOL } from "@/api/terminal-host-protocol-version";

import { embeddedHostBuildId } from "./host-build-id";
import type { HostEntry } from "./host-files";
import { ensureRunDir, hostEntryPath, hostSocketPath, isHostId } from "./host-files";
import { HostLog } from "./host-log";
import { TerminalHostService } from "./host-service";
import { InProcessTerminalHost } from "./in-process-terminal-host";

const { values } = parseArgs({
  options: {
    "run-dir": { type: "string" },
    "socket-dir": { type: "string" },
    "host-id": { type: "string" },
    "log-file": { type: "string" },
    "build-id": { type: "string" },
  },
});
const runDir = values["run-dir"];
const socketDir = values["socket-dir"];
const hostId = values["host-id"];
const logFile = values["log-file"];
const hostBuildId = embeddedHostBuildId() ?? values["build-id"];
if (!runDir || !socketDir || !hostId || !isHostId(hostId) || !logFile || !hostBuildId) {
  throw new Error(
    "Usage: loxel-terminal-host --run-dir <dir> --socket-dir <dir> --host-id <id> --log-file <path> [--build-id <id>]",
  );
}

const hostLog = new HostLog(logFile);
const log = hostLog.logger({ hostId });
const socketPath = hostSocketPath(socketDir, hostId);
const entryPath = hostEntryPath(runDir, hostId);

process.on("uncaughtException", (err) => {
  // Exiting would end every shell; the error is logged and the host keeps serving the rest.
  log.error("Uncaught exception in the terminal host", { error: err });
});
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection in the terminal host", {
    error: reason instanceof Error ? reason : new Error(String(reason)),
  });
});

const host = new InProcessTerminalHost({ log });
const service = new TerminalHostService({
  host,
  hostBuildId,
  log,
  setLogForward: (forward) => hostLog.setForward(forward),
  onDone: () => exit(0),
});

function exit(code: number): never {
  service.close();
  rmSync(socketPath, { force: true });
  rmSync(entryPath, { force: true });
  hostLog.close();
  process.exit(code);
}

// SIGTERM is the fallback for a host that cannot be reached over its socket: end the sessions.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log.info(`Received ${signal}, ending every session`);
    for (const id of host.sessionIds()) host.destroy(id);
    exit(0);
  });
}
// The host has no controlling terminal, but a hangup must never take every shell down with it.
process.on("SIGHUP", () => log.warn("Ignoring SIGHUP"));

ensureRunDir(runDir);
ensureRunDir(socketDir);
await service.listen(socketPath);
chmodSync(socketPath, 0o600);
const entry: HostEntry = {
  pid: process.pid,
  build: hostBuildId,
  protocol: TERMINAL_HOST_PROTOCOL,
  socket: socketPath,
};
writeFileSync(entryPath, JSON.stringify(entry), { mode: 0o600 });
log.info(`Terminal host ${hostBuildId} listening (pid ${process.pid})`);

// Tell the launcher the socket is up, then point stdout at /dev/null: the launcher closes its end,
// and nothing may write to a closed pipe. The lowest free descriptor is reused, which is 1 here.
writeSync(1, "ready\n");
closeSync(1);
const devNull = openSync("/dev/null", "w");
if (devNull !== 1) log.warn(`stdout was not replaced: /dev/null opened as ${devNull}`);
