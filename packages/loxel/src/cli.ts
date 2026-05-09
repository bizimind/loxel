#!/usr/bin/env bun
import { dirname, resolve } from "node:path";

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

async function detectWorktree(filePath: string): Promise<string> {
  const dir = dirname(filePath);
  const proc = Bun.spawn(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`File is not inside a git repository: ${filePath}`);
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

async function sendOpen(port: number, body: Record<string, string>): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const data: Record<string, unknown> = await res.json().catch(() => ({}));
    const message = typeof data.error === "string" ? data.error : `Server returned ${res.status}`;
    throw new Error(message);
  }
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

  // Detect worktree: from file path for files, from CWD for URLs.
  // Inside loxel terminal, fall back to LOXEL_WORKTREE env for files outside any git repo.
  const filePath = isUrl ? null : resolve(rawArg);
  let wtPath: string;
  try {
    wtPath = await detectWorktree(filePath ?? process.cwd());
  } catch (err) {
    if (isInsideLoxel && envWorktree) {
      wtPath = envWorktree;
    } else {
      throw new Error(`File is not inside a git repository: ${filePath ?? process.cwd()}`, {
        cause: err,
      });
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

  await sendOpen(port, isUrl ? { url: rawArg, wtPath } : { filePath: filePath!, wtPath });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`loxel: ${message}\n`);
  process.exit(1);
});
