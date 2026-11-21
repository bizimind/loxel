/**
 * Smoke test of what Loxel takes from its patched Electron (docs/PATCHED_ELECTRON.md), on a build of
 * it, on macOS:
 *
 *   ELECTRON_OVERRIDE_DIST_PATH=<dir holding Electron.app> bun scripts/patched-electron-smoke.ts
 *
 * Serves local test pages and starts a hidden Electron app (`patched-electron-smoke/main.cjs`, no
 * window ever shown) that checks each patch's behavior: file access prompts (0005), quarantine
 * (0006), Local Network Access (0007), `exitExclusiveAccess()` (0008), and the `<usermedia>`
 * element's permission calls. Prints one line per check and exits 1 if any fails. CI can't run it:
 * it needs a patched build.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
/** The npm package resolves to the binary ELECTRON_OVERRIDE_DIST_PATH names, when set. */
const electronPath: unknown = require("electron");
if (typeof electronPath !== "string") throw new Error("The electron package gave no binary path");
if (!process.env.ELECTRON_OVERRIDE_DIST_PATH) {
  console.warn("[smoke] ELECTRON_OVERRIDE_DIST_PATH is unset: testing stock Electron, which fails");
}

/** How long the whole run may take before it counts as hung. */
const RUN_TIMEOUT_MS = 180_000;

const PAGE = "<!doctype html><title>smoke</title><body style='height:100vh'>smoke</body>";
/** A `<usermedia>` element (a camera and microphone button) to click. */
const USERMEDIA_PAGE = `<!doctype html><title>usermedia</title>
<usermedia type="camera microphone" style="display:inline-block;width:200px;height:40px"></usermedia>`;

const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });

let targetRequests = 0;
/** This machine's API, which pages try to reach. */
const target = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => {
    targetRequests++;
    return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
  },
});
/** A dev server, reached on `localhost` and on the LAN address. */
const dev = Bun.serve({
  hostname: "0.0.0.0",
  port: 0,
  fetch: (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/usermedia") return html(USERMEDIA_PAGE);
    if (pathname === "/count") return new Response(String(targetRequests));
    if (pathname === "/download") {
      return new Response("downloaded", {
        headers: { "content-disposition": 'attachment; filename="smoke.bin"' },
      });
    }
    return html(PAGE);
  },
});
/** A page the Electron app is told is on a public address (--ip-address-space-overrides). */
const publicSite = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => html(PAGE) });

/** An IPv4 address of this Mac on its local network, if it has one. */
function lanAddress(): string | null {
  for (const addresses of Object.values(os.networkInterfaces())) {
    const lan = addresses?.find((a) => a.family === "IPv4" && !a.internal);
    if (lan) return lan.address;
  }
  return null;
}

const lan = lanAddress();
/** The app's files and Chromium profile; removed once the app has exited, as Chromium writes it until then. */
const scratch = mkdtempSync(path.join(os.tmpdir(), "loxel-patched-electron-smoke-"));
const config = {
  scratch,
  page: `http://localhost:${dev.port}/`,
  publicPage: `http://127.0.0.1:${publicSite.port}/`,
  lanPage: lan ? `http://${lan}:${dev.port}/` : null,
  target: `http://127.0.0.1:${target.port}/`,
  targetCount: `http://127.0.0.1:${dev.port}/count`,
  download: `http://localhost:${dev.port}/download`,
};

const app = Bun.spawn(
  [
    electronPath,
    path.join(import.meta.dirname, "patched-electron-smoke", "main.cjs"),
    "--enable-features=LocalNetworkAccessChecks",
    `--ip-address-space-overrides=127.0.0.1:${publicSite.port}=public`,
    "--disable-backgrounding-occluded-windows",
  ],
  {
    env: { ...process.env, SMOKE_CONFIG: JSON.stringify(config) },
    stdout: "pipe",
    stderr: "inherit",
  },
);
const hung = setTimeout(() => app.kill(), RUN_TIMEOUT_MS);

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

const results: Result[] = [];
let done = false;
let buffered = "";
for await (const chunk of app.stdout.pipeThrough(new TextDecoderStream())) {
  buffered += chunk;
  const lines = buffered.split("\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) {
    if (line === "SMOKE_DONE") done = true;
    if (!line.startsWith("SMOKE ")) continue;
    const result: unknown = JSON.parse(line.slice("SMOKE ".length));
    if (typeof result !== "object" || result === null) continue;
    results.push({
      name: String(Reflect.get(result, "name")),
      ok: Reflect.get(result, "ok") === true,
      detail: String(Reflect.get(result, "detail") ?? ""),
    });
  }
}
await app.exited;
rmSync(scratch, { recursive: true, force: true });
clearTimeout(hung);
for (const server of [target, dev, publicSite]) void server.stop(true);

for (const { name, ok, detail } of results) {
  console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const failed = results.filter((r) => !r.ok).length;
if (!done) console.log("FAIL  the app didn't finish (hung or crashed)");
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 || !done ? 1 : 0);
