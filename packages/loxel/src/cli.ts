#!/usr/bin/env bun
import { resolve } from "node:path";

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

function launchLoxel(): void {
  Bun.spawn(["open", "-a", "Loxel"], { stdout: "ignore", stderr: "ignore" });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // No arguments: focus/launch loxel
  if (args.length === 0) {
    launchLoxel();
    return;
  }

  const rawArg = args[0]!;
  const isUrl = isHttpUrl(rawArg);

  // Check env vars (inside loxel terminal)
  const isInsideLoxel = process.env.LOXEL === "1";
  const envPort = process.env.LOXEL_PORT ? parseInt(process.env.LOXEL_PORT, 10) : null;
  const envWorktree = process.env.LOXEL_WORKTREE;

  // URLs open in the windows showing the CWD's worktree. Inside a loxel terminal, fall back to
  // LOXEL_WORKTREE when the CWD is outside any git repo.
  let urlWtPath: string | null = null;
  if (isUrl) {
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
    launchLoxel(); // focus if running, launch if not
    port = detectedPort ?? PROD_PORT;
    if (!detectedPort) await waitForServer(port);
  }
  const serverUrl = `http://127.0.0.1:${port}`;

  if (urlWtPath) {
    await requestOpen(serverUrl, { url: rawArg, wtPath: urlWtPath });
    return;
  }

  // Files and folders need no worktree: the window in use opens them in their worktree, or in its
  // Others section — from a loxel terminal, that terminal's window; otherwise the focused one.
  const envWindowId = process.env.LOXEL_WINDOW_ID;
  await requestOpen(
    serverUrl,
    {
      filePath: resolve(rawArg),
      ...(isInsideLoxel && envWindowId ? { windowId: envWindowId } : {}),
    },
    { onWaiting: () => process.stderr.write("loxel: waiting for a Loxel window...\n") },
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`loxel: ${message}\n`);
  process.exit(1);
});
