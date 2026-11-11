#!/usr/bin/env bun
import { DEFAULT_SERVER_PORT } from "./app-ports";
import { parseOpenArgs, parseTerminalArgs, planOpens } from "./cli-args";
import { isCodingAgent } from "./coding-agent-env";
import { requestOpenAll } from "./open-request";
import { isHttpUrl } from "./url-utils";

const PROD_PORT = DEFAULT_SERVER_PORT.production;
const DEV_PORT = DEFAULT_SERVER_PORT.dev;

/** Whether a Loxel server is answering on `port`. One that is shutting down (its app is quitting or restarting to update) does not count: its replacement is the one to talk to. */
async function isServerRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/version`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return false;
    const body: unknown = await res.json().catch(() => null);
    return !(
      typeof body === "object" &&
      body !== null &&
      "shuttingDown" in body &&
      body.shuttingDown === true
    );
  } catch {
    return false;
  }
}

async function detectPort(): Promise<number | null> {
  if (await isServerRunning(PROD_PORT)) return PROD_PORT;
  if (await isServerRunning(DEV_PORT)) return DEV_PORT;
  return null;
}

async function detectWorktree(dir: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Not inside a git repository: ${dir}`);
  }
  const stdout = await new Response(proc.stdout).text();
  return stdout.trim();
}

async function waitForServer(port: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerRunning(port)) return;
    await Bun.sleep(200);
  }
  throw new Error(`Loxel server did not start within ${timeoutMs / 1000}s`);
}

/** Launch Loxel, or bring it to the front if it is running; `-g` launches it in the background. */
function launchLoxel({ background = false } = {}): void {
  const args = background ? ["open", "-g", "-a", "Loxel"] : ["open", "-a", "Loxel"];
  Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // No arguments: focus/launch loxel
  if (args.length === 0) {
    launchLoxel();
    return;
  }

  // `loxel terminal ...` opens a terminal panel, anything else files, folders and URLs. Parsed first
  // so bad flags fail before any launch.
  const parsed =
    args[0] === "terminal"
      ? parseTerminalArgs(args.slice(1), process.cwd())
      : parseOpenArgs(args, process.cwd());
  // Focus follows the caller unless a flag says otherwise: a coding agent's opens must not pull
  // the user away from what they are looking at, while a user's own opens show what they asked for.
  const focus = parsed.focus ?? !isCodingAgent(process.env);

  // Check env vars (inside loxel terminal)
  const isInsideLoxel = process.env.LOXEL === "1";
  const envPort = process.env.LOXEL_PORT ? parseInt(process.env.LOXEL_PORT, 10) : null;
  const envWorktree = process.env.LOXEL_WORKTREE;
  const envWindowId = process.env.LOXEL_WINDOW_ID;

  const targets = "targets" in parsed ? parsed.targets : [];
  const urlCount = targets.filter((target) => isHttpUrl(target)).length;
  // One worktree for the whole command: --worktree, else, for a command with a URL, the CWD's.
  // Inside a loxel terminal, fall back to LOXEL_WORKTREE when the CWD is outside any git repo. A
  // command of only files needs none: each file opens in its own worktree.
  const pinnedWorktree = parsed.worktree ? await detectWorktree(parsed.worktree) : null;
  let commandWorktree = pinnedWorktree;
  let urlError: string | null = null;
  if (!commandWorktree && urlCount > 0) {
    try {
      commandWorktree = await detectWorktree(process.cwd());
    } catch (err) {
      if (isInsideLoxel && envWorktree) commandWorktree = envWorktree;
      // With nothing else to open, fail before launching anything.
      else if (urlCount === targets.length) throw err;
      else urlError = err instanceof Error ? err.message : String(err);
    }
  }

  // Determine port and ensure server is running
  let port: number;
  if (isInsideLoxel && envPort) {
    port = envPort;
  } else {
    const detectedPort = await detectPort();
    // Bring Loxel to the front, or launch it; without focus, only launch it, in the background.
    if (focus || !detectedPort) launchLoxel({ background: !focus });
    port = detectedPort ?? PROD_PORT;
    if (!detectedPort) await waitForServer(port);
  }
  const serverUrl = `http://127.0.0.1:${port}`;

  // The window in use: from a loxel terminal, that terminal's window; otherwise the focused one.
  const windowId = isInsideLoxel && envWindowId ? envWindowId : undefined;
  const options = { focus, ...(windowId ? { windowId } : {}) };
  const pin = pinnedWorktree ? { pinWtPath: pinnedWorktree } : {};
  const opens =
    "terminal" in parsed
      ? [
          {
            label: "",
            request: { terminal: parsed.terminal, placement: parsed.placement, ...pin, ...options },
          },
        ]
      : planOpens(parsed, { baseDir: process.cwd(), pinnedWorktree, commandWorktree, options });
  for (const { label } of opens.filter((open) => !open.request)) {
    process.stderr.write(`loxel: ${label}${urlError}\n`);
  }
  const sendable = opens.flatMap(({ label, request }) => (request ? [{ label, request }] : []));

  const { warnings, failures } = await requestOpenAll(
    serverUrl,
    sendable.map((open) => open.request),
    { onWaiting: () => process.stderr.write("loxel: waiting for a Loxel window...\n") },
  );
  for (const warning of warnings) process.stderr.write(`loxel: warning: ${warning}\n`);
  for (const { index, message } of failures) {
    process.stderr.write(`loxel: ${sendable[index]!.label}${message}\n`);
  }
  if (urlError || failures.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`loxel: ${message}\n`);
  process.exit(1);
});
