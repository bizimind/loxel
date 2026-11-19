/**
 * Start a standalone server bundle's `loxel-server` as a service would, without the app, and check
 * that it works:
 *
 *   bun scripts/smoke-test-server-bundle.ts <bundle-dir>
 *
 * With a throwaway state directory and port, it waits for the session token the server writes,
 * then checks that `/api/version` answers, that `/api` refuses a request without the token and
 * answers one with it, that the renderer beside the binary is served, and that a terminal spawned
 * through the bundled terminal host runs a command. It stops the server and the host afterwards.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { readSessionToken, sessionTokenPath } from "../src/app-session";
import { sessionAuthorization } from "../src/session-client";
import { stopHosts } from "../src/test/terminal-hosts";
import { freePort, openPanel } from "../src/test/terminal-panel";
import { until } from "../src/test/until";

const TIMEOUT_MS = 60_000;

const bundleDir = Bun.argv[2];
if (!bundleDir) throw new Error("Usage: smoke-test-server-bundle.ts <bundle-dir>");
const serverBinary = path.resolve(bundleDir, "loxel-server");
if (!existsSync(serverBinary)) throw new Error(`No loxel-server in ${bundleDir}`);

const { version: expectedVersion } = z
  .object({ version: z.string() })
  .parse(await Bun.file(path.join(import.meta.dir, "..", "package.json")).json());

/** Fail with what the response said, so a CI log shows why. */
async function expectStatus(response: Response, status: number, what: string): Promise<Response> {
  if (response.status === status) return response;
  throw new Error(`${what}: expected ${status}, got ${response.status}: ${await response.text()}`);
}

// Short, so the host's socket path fits the platform's limit.
const stateDir = realpathSync(mkdtempSync("/tmp/lx-smoke-"));
const port = freePort();
const baseUrl = `http://127.0.0.1:${port}`;
// Nothing from a dev or Loxel shell may point the server elsewhere: it finds its own renderer.
const env: Record<string, string | undefined> = {
  ...process.env,
  LOXEL_STATE_DIR: stateDir,
  LOXEL_SERVE_PORT: String(port),
  SHELL: "/bin/sh",
};
for (const name of ["LOXEL_DEV", "LOXEL_DEMO", "LOXEL_STATIC_DIR", "LOXEL_PARENT_PID"]) {
  delete env[name];
}

console.log(`[smoke] starting ${serverBinary} on ${baseUrl}, state in ${stateDir}`);
// No stdin: the server finds no data encryption key, as on a machine without a keychain.
const server = Bun.spawn([serverBinary], { env, stdio: ["ignore", "inherit", "inherit"] });

try {
  // The token is written just before the server listens.
  await until(
    () => {
      if (server.exitCode !== null) throw new Error(`The server exited with ${server.exitCode}`);
      return readSessionToken(stateDir) !== null;
    },
    TIMEOUT_MS,
    "the session token",
  );
  console.log(`[smoke] session token at ${sessionTokenPath(stateDir)}`);
  const auth = sessionAuthorization(stateDir);

  // Listening follows the token: retry until the port takes connections.
  const deadline = Date.now() + TIMEOUT_MS;
  let answered: Response | null = null;
  while (!answered) {
    answered = await fetch(`${baseUrl}/api/version`).catch(() => null);
    if (answered) break;
    if (server.exitCode !== null) throw new Error(`The server exited with ${server.exitCode}`);
    if (Date.now() > deadline) throw new Error("/api/version never answered");
    await Bun.sleep(50);
  }
  const version = await expectStatus(answered, 200, "/api/version");
  const info = (await version.json()) as { version?: unknown; isDev?: unknown };
  if (info.version !== expectedVersion || info.isDev !== false) {
    throw new Error(`/api/version: unexpected ${JSON.stringify(info)}`);
  }
  console.log(`[smoke] /api/version: ${JSON.stringify(info)}`);

  await expectStatus(await fetch(`${baseUrl}/api/terminals`), 401, "/api/terminals without token");
  await expectStatus(
    await fetch(`${baseUrl}/api/terminals`, { headers: auth }),
    200,
    "/api/terminals with token",
  );
  console.log("[smoke] /api/terminals refuses without the token and answers with it");

  const page = await (await expectStatus(await fetch(`${baseUrl}/`), 200, "/")).text();
  if (!page.includes('<div id="root">')) throw new Error(`/ is not the renderer: ${page}`);
  console.log("[smoke] the renderer is served");

  const panel = await openPanel(baseUrl, auth);
  const id = crypto.randomUUID();
  panel.attach(id);
  await until(() => panel.states.length > 0, TIMEOUT_MS, "the terminal's first state");
  panel.claim(id);
  // Quoted apart, so the echo of the typed line itself never reads as the output.
  panel.type(id, 'echo loxel-""smoke');
  const shows = () => (panel.states.at(-1)?.snapshot ?? "") + panel.text();
  await until(() => shows().includes("loxel-smoke\r\n"), TIMEOUT_MS, "the command's output");
  // The bundled CLI, from the bin/ directory the server puts first on the terminal's PATH.
  panel.type(id, 'echo "cli-$(loxel --version)"');
  await until(() => /cli-\d+\.\d+\.\d+\r\n/.test(shows()), TIMEOUT_MS, "the bundled CLI's version");
  panel.destroy(id);
  panel.close();
  console.log("[smoke] a terminal ran a command through the terminal host");
} finally {
  server.kill("SIGTERM");
  await server.exited;
  stopHosts(stateDir);
  // A host still writing its log as it ends can make this fail; that must not hide the result.
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[smoke] could not remove ${stateDir}:`, error);
  }
}
console.log("[smoke] passed");
