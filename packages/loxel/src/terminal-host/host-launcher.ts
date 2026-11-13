/**
 * Starting a terminal host process, detached from the server so it outlives it. See
 * docs/TERMINAL_HOST.md#the-process.
 *
 * - A packaged server (a compiled binary) runs the host binary bundled next to it, from a clone
 *   at `<stateDir>/terminal-host/bin/<hostBuildId>/`, so no host maps a file of the app bundle and
 *   an update can replace the bundle under running hosts. On APFS the clone is copy-on-write and
 *   takes no space; elsewhere it is a copy.
 * - A server built as a bundle runs the host bundle next to its own with the same Bun.
 * - A server run from source runs the host's source with the same Bun; nothing is copied.
 *
 * The host is started in its own session (setsid), with no inherited environment or descriptors
 * beyond its log, and signals on stdout once its socket is up.
 */
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { TERMINAL_HOST_ENTRY, embeddedHostBuildId } from "./host-build-id";
import {
  TERMINAL_HOST_BINARY,
  ensureRunDir,
  hostBinDir,
  hostLogPath,
  hostLogsDir,
  hostSocketPath,
} from "./host-files";

/** How long a starting host has to report its socket up. */
const READY_TIMEOUT_MS = 15_000;

/** The host bundle's name next to a server bundle (scripts/build-server.ts). */
export const TERMINAL_HOST_BUNDLE = "terminal-host.js";

export interface HostLaunch {
  stateDir: string;
  runDir: string;
  hostId: string;
  hostBuildId: string;
  /** The command that starts the host, before its arguments; defaults to {@link hostCommand}. */
  command?: readonly string[];
}

export interface LaunchedHost {
  pid: number;
  socketPath: string;
}

/** Start a host and resolve once its socket accepts connections. */
export async function launchHost(launch: HostLaunch): Promise<LaunchedHost> {
  const { stateDir, runDir, hostId, hostBuildId } = launch;
  const command = launch.command ?? hostCommand(stateDir, hostBuildId);
  ensureRunDir(runDir);
  mkdirSync(hostLogsDir(stateDir), { recursive: true });
  const logFile = hostLogPath(stateDir, hostId);
  // What the host itself cannot log (a crash of the runtime) lands next to its log.
  const stderrPath = `${logFile}.stderr`;
  const stderr = openSync(stderrPath, "a", 0o600);
  let proc;
  try {
    proc = Bun.spawn(
      [
        ...command,
        "--run-dir",
        runDir,
        "--host-id",
        hostId,
        "--log-file",
        logFile,
        "--build-id",
        hostBuildId,
      ],
      { cwd: "/", env: hostEnv(), detached: true, stdin: "ignore", stdout: "pipe", stderr },
    );
  } finally {
    closeSync(stderr);
  }
  proc.unref();

  const ready = await readReady(proc.stdout, READY_TIMEOUT_MS);
  if (!ready) {
    proc.kill();
    const exitCode = await Promise.race([proc.exited, Promise.resolve(null)]);
    throw new Error(
      `Terminal host did not start (exit code ${exitCode ?? "none yet"}); see ${stderrPath}`,
    );
  }
  return { pid: proc.pid, socketPath: hostSocketPath(runDir, hostId) };
}

/**
 * The command that starts this build's host: the installed clone of the bundled binary for a
 * packaged server, else the host's bundle or source run by this Bun.
 */
export function hostCommand(stateDir: string, hostBuildId: string): string[] {
  if (Bun.main.startsWith("/$bunfs/")) {
    const bundled = join(dirname(process.execPath), TERMINAL_HOST_BINARY);
    return [installHostBinary(stateDir, hostBuildId, bundled)];
  }
  if (embeddedHostBuildId() !== null) {
    return [process.execPath, join(dirname(Bun.main), TERMINAL_HOST_BUNDLE)];
  }
  return [process.execPath, TERMINAL_HOST_ENTRY];
}

/**
 * The host binary for `hostBuildId` under the state directory, cloned from `bundled` the first
 * time: the clone is made beside its final name and renamed into place, so a binary at that path
 * is always whole.
 */
export function installHostBinary(stateDir: string, hostBuildId: string, bundled: string): string {
  const dir = join(hostBinDir(stateDir), hostBuildId);
  const target = join(dir, TERMINAL_HOST_BINARY);
  if (existsSync(target)) return target;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const partial = `${target}.${process.pid}.partial`;
  // FICLONE clones where the file system can (APFS) and copies where it cannot.
  copyFileSync(bundled, partial, constants.COPYFILE_FICLONE);
  renameSync(partial, target);
  return target;
}

/** Only what the runtime needs: each session gets its whole environment from the server. */
function hostEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["HOME", "TMPDIR", "LANG"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** True once `stdout` carries `ready`; false when it ends first or `timeoutMs` passes. */
async function readReady(stdout: ReadableStream<Uint8Array>, timeoutMs: number): Promise<boolean> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    for (;;) {
      const read = await Promise.race([reader.read(), timedOut]);
      if (read === "timeout" || read.done) return false;
      text += decoder.decode(read.value, { stream: true });
      if (text.includes("ready\n")) return true;
    }
  } finally {
    clearTimeout(timer);
    // Closes the pipe: the host has pointed its stdout elsewhere by now.
    void reader.cancel().catch(() => {});
  }
}
