/**
 * Start the demo app visibly, to look around: recreate the demo projects, build the app, and start
 * it in demo mode (`LOXEL_DEMO=1`: its own port, state and data directory, beside the installed
 * Loxel) with the projects registered and a fresh state. The site's screenshots are captured
 * hidden by `capture-shots.ts` instead.
 *
 * Usage: bun scripts/demo/launch.ts [--no-build]
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { $ } from "bun";

import {
  buildDemoApp,
  DEMO_PID_FILE,
  DEMO_SERVER,
  demoEnv,
  demoServerAnswers,
  demoStateDir,
  LOXEL_ROOT,
  MAIN_JS,
  registerDemoProjects,
} from "./demo-app";
import { createDemoProjects, DEMO_ROOT } from "./demo-projects";

/** The visible demo is instance 0; capture-shots.ts uses the others. */
const INSTANCE = 0;
/** Demo mode's own state directory, reset so every run starts clean. */
const DEMO_STATE_DIR = demoStateDir(INSTANCE);

/** The Electron binary's path, which the `electron` package exports when run under Node or Bun. */
function electronBinary(): string {
  const path: unknown = createRequire(import.meta.url)("electron");
  if (typeof path !== "string") throw new Error("The electron package exported no binary path");
  return path;
}

/** Stop a demo app an earlier run left running: only the Electron process this script started. */
async function stopPreviousDemo(): Promise<void> {
  const pidFile = Bun.file(DEMO_PID_FILE);
  if (!(await pidFile.exists())) return;
  const pid = Number((await pidFile.text()).trim());
  const command = (await $`ps -p ${pid} -o comm=`.nothrow().quiet()).stdout.toString();
  if (!command.includes("Electron.app/Contents/MacOS/Electron")) return;
  process.kill(pid);
  while ((await $`ps -p ${pid}`.nothrow().quiet()).exitCode === 0) await Bun.sleep(200);
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await demoServerAnswers(INSTANCE)) return;
    await Bun.sleep(500);
  }
  throw new Error(`The demo server did not answer on ${DEMO_SERVER} within a minute`);
}

if (!process.argv.includes("--no-build")) await buildDemoApp();
await stopPreviousDemo();
await $`rm -rf ${DEMO_STATE_DIR}`.quiet();
const worktrees = await createDemoProjects();

const app = spawn(electronBinary(), [MAIN_JS], {
  cwd: LOXEL_ROOT,
  env: demoEnv(INSTANCE, false),
  detached: true,
  stdio: "ignore",
});
app.unref();
const { pid } = app;
if (pid === undefined) throw new Error("Electron did not start");
await Bun.write(DEMO_PID_FILE, String(pid));

await waitForServer();
await registerDemoProjects(INSTANCE);

const counts = Object.entries(worktrees).map(
  ([name, paths]) => `${name} (${Object.keys(paths).length} worktrees)`,
);
console.log(`Loxel demo is running (pid ${pid}) with ${counts.join(" and ")} in ${DEMO_ROOT}.`);
