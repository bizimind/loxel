import { readFileSync, rmSync, unlinkSync } from "node:fs";

interface RunMeta {
  pid: number;
  port: number;
  stateDir: string;
  runId: string;
}

export default async function globalTeardown() {
  const port = process.env.LOXEL_PORT;
  if (!port) return;

  // Find the temp file written by global-setup
  const { readdirSync } = await import("node:fs");
  const files = readdirSync("/tmp")
    .filter((f) => f.startsWith("loxel-e2e-") && f.endsWith(".json"))
    .map((f) => `/tmp/${f}`);

  for (const file of files) {
    let meta: RunMeta;
    try {
      meta = JSON.parse(readFileSync(file, "utf8")) as RunMeta;
    } catch {
      continue;
    }

    if (String(meta.port) !== port) continue;

    // Kill the server process
    try {
      process.kill(meta.pid, "SIGTERM");
    } catch {
      // Already gone
    }

    // Remove state dir
    try {
      rmSync(meta.stateDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }

    // Remove the temp JSON file
    try {
      unlinkSync(file);
    } catch {
      // Best effort
    }

    break;
  }
}
