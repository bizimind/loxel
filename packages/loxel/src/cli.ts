#!/usr/bin/env bun
import { resolve } from "node:path";

import { parseOpenArgs, parseTerminalArgs } from "./cli-args";
import { isCodingAgent } from "./coding-agent-env";
import { requestOpen } from "./open-request";
import { isHttpUrl } from "./url-utils";

const PROD_PORT = 7433;
const DEV_PORT = 7434;

async function isServerRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/version`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
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

  // `loxel terminal ...` opens a terminal panel, anything else a file, folder or URL. Parsed first
  // so bad flags fail before any launch.
  const parsed =
    args[0] === "terminal"
      ? parseTerminalArgs(args.slice(1), process.cwd())
      : parseOpenArgs(args, process.cwd());
  const url = "target" in parsed && isHttpUrl(parsed.target) ? parsed.target : null;
  // Focus follows the caller unless a flag says otherwise: a coding agent's opens must not pull
  // the user away from what they are looking at, while a user's own opens show what they asked for.
  const focus = parsed.focus ?? !isCodingAgent(process.env);

  // Check env vars (inside loxel terminal)
  const isInsideLoxel = process.env.LOXEL === "1";
  const envPort = process.env.LOXEL_PORT ? parseInt(process.env.LOXEL_PORT, 10) : null;
  const envWorktree = process.env.LOXEL_WORKTREE;
  const envWindowId = process.env.LOXEL_WINDOW_ID;

  // URLs open in the windows showing the CWD's worktree. Inside a loxel terminal, fall back to
  // LOXEL_WORKTREE when the CWD is outside any git repo.
  let urlWtPath: string | null = null;
  if (url) {
    try {
      urlWtPath = await detectWorktree(process.cwd());
    } catch (err) {
      if (!isInsideLoxel || !envWorktree) throw err;
      urlWtPath = envWorktree;
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
  // Files, folders and terminals need no worktree: that window opens them in their worktree, or
  // in its Others section (a terminal: in the active worktree). A URL goes to every window
  // showing its worktree, and the one in use among them applies the placement.
  const windowId = isInsideLoxel && envWindowId ? { windowId: envWindowId } : {};
  const opened = { placement: parsed.placement, focus, ...windowId };
  const { warning } = await requestOpen(
    serverUrl,
    url && urlWtPath
      ? { url, wtPath: urlWtPath, ...opened }
      : "target" in parsed
        ? { filePath: resolve(parsed.target), ...opened }
        : { terminal: parsed.terminal, ...opened },
    { onWaiting: () => process.stderr.write("loxel: waiting for a Loxel window...\n") },
  );
  if (warning) process.stderr.write(`loxel: warning: ${warning}\n`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`loxel: ${message}\n`);
  process.exit(1);
});
