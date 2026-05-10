import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";

const LOXEL_ROOT = resolve(import.meta.dirname, "..");
const BASE_PORT = 17434;
const MAX_PORT = 17534;
const POLL_INTERVAL_MS = 500;
const STARTUP_TIMEOUT_MS = 30_000;

function isPortFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const server = createServer();
    server.once("error", () => res(false));
    server.once("listening", () => server.close(() => res(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function findFreePort(): Promise<number> {
  for (let port = BASE_PORT; port <= MAX_PORT; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in range ${BASE_PORT}–${MAX_PORT}`);
}

async function pollUntilReady(url: string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Loxel server did not become ready within ${STARTUP_TIMEOUT_MS}ms`);
}

export default async function globalSetup() {
  const runId = randomUUID();
  const stateDir = `/tmp/loxel-e2e-${runId}`;
  const port = await findFreePort();
  const tempFile = `/tmp/loxel-e2e-${runId}.json`;

  mkdirSync(stateDir, { recursive: true });

  // Build the Vite client with VITE_SCREENSHOT=1 so screenshot mode is baked in.
  const buildResult = spawnSync("bun", ["run", "build:ui"], {
    cwd: LOXEL_ROOT,
    env: { ...process.env, VITE_SCREENSHOT: "1" },
    stdio: "inherit",
  });
  if (buildResult.status !== 0) {
    throw new Error(`Vite client build failed with exit code ${buildResult.status}`);
  }

  const proc = spawn("bun", ["run", "src/server/index.ts"], {
    cwd: LOXEL_ROOT,
    env: { ...process.env, LOXEL_DEV: "1", LOXEL_STATE_DIR: stateDir, LOXEL_PORT: String(port) },
    stdio: "ignore",
    detached: false,
  });

  // Store metadata for teardown
  writeFileSync(tempFile, JSON.stringify({ pid: proc.pid, port, stateDir, runId }));

  // Make port available to tests running in this process
  process.env.LOXEL_PORT = String(port);

  await pollUntilReady(`http://localhost:${port}/api/version`);
}
