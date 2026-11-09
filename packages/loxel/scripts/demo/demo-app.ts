/**
 * What every way of starting a demo app shares: where the app is built, its environment, its
 * server and state, and the demo projects registered with it. `launch.ts` starts a visible one;
 * `demo-session.ts` drives hidden ones for the screenshots.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

import { $ } from "bun";

import type { RepoTrustDecision } from "../../src/api/repo-trust-model";
import { withoutAgentEnv } from "../../src/coding-agent-env";
import { DEMO_PROJECTS, DEMO_ROOT, demoWorktree } from "./demo-projects";

export const LOXEL_ROOT = resolve(import.meta.dirname, "../..");
/** The app's main process, as `ELECTRON=1 vite build` writes it. */
export const MAIN_JS = resolve(LOXEL_ROOT, "dist-electron/main/main.js");

/** Build the app (main process and renderer) that the demo runs from the source tree. */
export async function buildDemoApp(): Promise<void> {
  await $`pnpm exec vite build`
    .cwd(LOXEL_ROOT)
    .env({ ...process.env, ELECTRON: "1" })
    .quiet();
}

/** A demo instance's server (`LOXEL_DEMO_INSTANCE`): demo mode's port plus the instance number. */
export const demoServer = (instance = 0) => `http://127.0.0.1:${7435 + instance}`;

/** A demo instance's state directory (src/server/config.ts). */
export const demoStateDir = (instance = 0) =>
  resolve(homedir(), ".local/state/loxel", instance ? `loxel-demo-${instance}` : "loxel-demo");

/** Where `launch.ts` keeps the visible demo app's process ID, to stop it on the next launch. */
export const DEMO_PID_FILE = resolve(demoStateDir(0), "demo-app.pid");

export const DEMO_SERVER = demoServer(0);

/**
 * Variables that would point a demo at another Loxel: a dev Loxel's renderer (`VITE_DEV_SERVER_URL`,
 * `LOXEL_DEV`), or the state, port and renderer of the Loxel whose terminal started the demo.
 */
const OTHER_LOXEL_ENV_VARS = [
  "VITE_DEV_SERVER_URL",
  "LOXEL_DEV",
  "LOXEL_STATE_DIR",
  "LOXEL_SERVE_PORT",
  "LOXEL_STATIC_DIR",
];

/** The environment of demo app `instance`: this one's, cut loose from any agent or Loxel. */
export function demoEnv(instance: number, hidden: boolean): Record<string, string> {
  const env = withoutAgentEnv(process.env);
  for (const name of OTHER_LOXEL_ENV_VARS) delete env[name];
  return {
    ...env,
    LOXEL_DEMO: "1",
    LOXEL_DEMO_INSTANCE: String(instance),
    ...(hidden ? { LOXEL_DEMO_HIDDEN: "1" } : {}),
  };
}

/** Whether a demo app's server answers on `instance`'s port. */
export const demoServerAnswers = (instance: number): Promise<boolean> =>
  fetch(`${demoServer(instance)}/api/version`).then(
    (res) => res.ok,
    () => false,
  );

/** Register the demo projects with demo app `instance`, their default branches trusted. */
export async function registerDemoProjects(instance: number): Promise<void> {
  const post = async (path: string, body: object) => {
    const res = await fetch(`${demoServer(instance)}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} failed (${res.status}): ${await res.text()}`);
  };
  for (const project of DEMO_PROJECTS) {
    await post("/api/projects", { path: resolve(DEMO_ROOT, project.name), name: project.name });
    // Trusted, so language tooling runs and no "Restricted" notice shows.
    await post("/api/repo-trust", {
      worktreePath: demoWorktree(project.name, project.defaultBranch),
      decision: "trusted" satisfies RepoTrustDecision,
    });
  }
}
