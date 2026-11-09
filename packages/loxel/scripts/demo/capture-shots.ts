/**
 * Stage and capture the site's screenshots (shots.md) without ever showing a window: a hidden demo
 * app, each shot (shots/<name>.ts) set up with the `loxel` CLI and input sent to the page, its
 * content captured with `capturePage()` and composited into the real window frame. Several runs
 * can go at once with different instances, each with its own app, state and Codex home. The demo
 * projects are cloned and the app built on the first run; `--build` rebuilds the app.
 *
 * Usage: bun scripts/demo/capture-shots.ts [--instance <n>] [--build] [shot names...]
 *
 * The instance defaults to 1: instance 0 is the visible demo of `launch.ts`.
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import type { Page } from "@playwright/test";
import { $ } from "bun";

import { buildDemoApp, demoServer, demoServerAnswers, demoStateDir, MAIN_JS } from "./demo-app";
import { createDemoProjects, DEMO_ROOT, demoWorktree } from "./demo-projects";
import { type DemoSession, launchDemo, saveShot } from "./demo-session";
import { clearLogsDot, parkMouse, SCREENSHOT_BRIEF, type Shot, Terminals, until } from "./shot-kit";

/** The worktree sidebar's right edge, in CSS pixels: wide enough for every task title. */
const SIDEBAR_WIDTH = 290;

const args = process.argv.slice(2);
const buildAt = args.indexOf("--build");
const build = buildAt !== -1;
if (build) args.splice(buildAt, 1);
const instanceAt = args.indexOf("--instance");
const instanceArg = instanceAt === -1 ? "1" : args.splice(instanceAt, 2)[1];
if (instanceArg === undefined || !/^\d+$/.test(instanceArg)) {
  throw new Error("--instance takes a non-negative integer");
}
const instance = Number(instanceArg);
const available = (await readdir(resolve(import.meta.dirname, "shots"))).map((f) =>
  f.replace(/\.ts$/, ""),
);
const names = args.length ? args : available;
const unknown = names.filter((n) => !available.includes(n));
if (unknown.length)
  throw new Error(`Unknown shots: ${unknown.join(", ")}; known: ${available.join(", ")}`);

const stateDir = demoStateDir(instance);
/** This instance's Codex home, so its Codex sessions need no command-line overrides. */
const codexHome = `${stateDir}-codex`;

/** How long ago each task was started, in minutes, so the sidebar reads like a real morning. */
const TASK_AGES: Record<string, Record<string, number>> = {
  loxel: {
    main: 60 * 24 * 14,
    "maximize-group": 190,
    "maximize-shortcut": 14,
    "maximize-tab-menu": 12,
    "site-fonts": 60 * 26,
    "hard-refresh": 130,
    "window-tiling": 250,
    "tiling-menu": 41,
    "tiling-docs": 38,
    "worktree-toast": 60 * 30,
    "feature-tour": 6,
  },
  excalidraw: { master: 60 * 24 * 21, "selection-color": 60 * 52 },
};

/** Set each worktree's creation time (its directory's birth time, shown as its age) to its age. */
async function setTaskAges(): Promise<void> {
  const pad = (n: number) => String(n).padStart(2, "0");
  for (const [project, ages] of Object.entries(TASK_AGES)) {
    for (const [task, minutes] of Object.entries(ages)) {
      const t = new Date(Date.now() - minutes * 60_000);
      const stamp = `${pad(t.getMonth() + 1)}/${pad(t.getDate())}/${t.getFullYear()} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
      // SetFile (Xcode's command line tools) moves a birth time either way; utimes only back.
      await $`SetFile -d ${stamp} -m ${stamp} ${demoWorktree(project, task)}`.quiet();
    }
  }
}

/** The developer tools' own bin directory, where `xcrun --find git` finds the real git. */
async function developerBin(): Promise<string> {
  return dirname((await $`xcrun --find git`.text()).trim());
}

/**
 * Set up the demo's Codex home: the user's sign-in (linked, so a token Codex refreshes here is
 * the user's own, refreshed) and model, and otherwise a plain config, so nothing in the footer or
 * the screenshot comes from the user's own setup: no update check, MCP servers, plugins or notify
 * hook, read-only and never asking, and every demo worktree trusted up front. Trust decisions and session logs stay here, out of ~/.codex.
 */
async function setUpCodexHome(worktrees: string[]): Promise<void> {
  const CODEX_HOME = codexHome;
  const userHome = resolve(homedir(), ".codex");
  const userConfig = await Bun.file(resolve(userHome, "config.toml"))
    .text()
    .catch(() => "");
  const model = userConfig.match(/^(model|model_reasoning_effort)\s*=.*$/gm) ?? [];
  const config = [
    ...model,
    "check_for_update_on_startup = false",
    'sandbox_mode = "read-only"',
    'approval_policy = "never"',
    "",
    // No "approaching rate limits, switch models?" prompt: it covers the answer and shows the
    // user's own usage.
    "[notice]",
    "hide_rate_limit_model_nudge = true",
    "",
    // Git from the developer tools directly: /usr/bin/git is xcrun's shim, which a read-only
    // sandbox stops from writing its cache, so every git command would print xcrun's errors.
    "[shell_environment_policy]",
    `set = { PATH = ${JSON.stringify(`${await developerBin()}:${process.env.PATH ?? ""}`)} }`,
    "",
    ...worktrees.flatMap((dir) => [`[projects."${dir}"]`, 'trust_level = "trusted"', ""]),
  ].join("\n");
  // Kept between runs (Codex installs its app-server there); only the config and brief are rewritten.
  await $`mkdir -p ${CODEX_HOME}`.quiet();
  await Bun.write(resolve(CODEX_HOME, "config.toml"), config);
  await $`ln -sf ${resolve(userHome, "auth.json")} ${resolve(CODEX_HOME, "auth.json")}`.quiet();
  await Bun.write(resolve(CODEX_HOME, "AGENTS.md"), `${SCREENSHOT_BRIEF}\n`);
}

/** The worktree sidebar expanded, and wide enough that no task title is cut off. */
async function expandSidebar(page: Page): Promise<void> {
  const expand = page.getByTitle("Expand sidebar");
  if (await expand.isVisible()) await expand.click();
  await page.locator(".wt-row").first().waitFor();
  await widenSidebar(page);
}

/** Drag the worktree sidebar's edge to SIDEBAR_WIDTH, so no task title is cut off. */
async function widenSidebar(page: Page): Promise<void> {
  const handle = () => page.getByLabel("Resize sidebar").boundingBox();
  const edge = async () => (await handle())?.x ?? 0;
  await until(
    async () => Math.abs((await edge()) - SIDEBAR_WIDTH) <= 6,
    async () => {
      // The resize is relative to where the drag starts, so wait out the sidebar's expand
      // animation first: a handle grabbed mid-way adds the rest of the animation to the width.
      let last = -1;
      while (last !== (await edge())) {
        last = await edge();
        await page.waitForTimeout(150);
      }
      const box = await handle();
      if (!box) return;
      await page.mouse.move(box.x + box.width / 2, box.y + 200);
      await page.mouse.down();
      await page.mouse.move(SIDEBAR_WIDTH + box.width / 2, box.y + 200, { steps: 8 });
      await page.mouse.up();
    },
    "set the sidebar's width",
  );
}

/** Inlay hints lengthen code lines past the editor's edge in a screenshot-sized window. */
async function turnOffInlayHints(page: Page): Promise<void> {
  const editorLink = page.locator("a.settings-nav-link", { hasText: "Editor" });
  await until(
    () => editorLink.isVisible(),
    () => page.getByLabel("Settings", { exact: true }).click(),
    "open Settings",
  );
  await editorLink.click();
  await page.locator("#editor-inlay-hints").selectOption("off");
  await page.getByRole("button", { name: "Save", exact: true }).click();
}

/** Stop the Codex app-server daemons this instance's Codex home started; they outlive the app. */
const stopCodexDaemons = () => $`pkill -f ${`${codexHome}/packages/`}`.quiet().nothrow();

/** A shot module: `shots/<name>.ts`, whose default export stages the shot. */
async function loadShot(name: string): Promise<(s: Shot) => Promise<void>> {
  const module: unknown = await import(`./shots/${name}.ts`);
  const stage =
    typeof module === "object" && module !== null && "default" in module ? module.default : null;
  if (typeof stage !== "function") throw new Error(`shots/${name}.ts exports no default function`);
  // A function, checked; its signature is the shots' convention (shots.md).
  return stage as (s: Shot) => Promise<void>;
}

// Before anything is reset: a demo app already on this instance would be wiped and fought over.
if (await demoServerAnswers(instance)) {
  throw new Error(
    `A demo app is already running on instance ${instance} (${demoServer(instance)}); quit it or use another --instance`,
  );
}
if (!(await Bun.file(resolve(DEMO_ROOT, "loxel/HEAD")).exists())) await createDemoProjects();
if (build || !(await Bun.file(MAIN_JS).exists())) await buildDemoApp();
await stopCodexDaemons();
await $`rm -rf ${stateDir}`.quiet();
await setTaskAges();
await setUpCodexHome(
  Object.entries(TASK_AGES).flatMap(([project, ages]) =>
    Object.keys(ages).map((task) => demoWorktree(project, task)),
  ),
);
let session: DemoSession | undefined;
try {
  session = await launchDemo({ hidden: true, instance });
  const { page } = session;
  const shot: Shot = { ...session, terminals: new Terminals(page), codexHome, cleanups: [] };
  await page
    .getByTitle(/^(Expand|Collapse) sidebar$/)
    .first()
    .waitFor();
  await turnOffInlayHints(page);
  for (const name of names) {
    const stage = await loadShot(name);
    // Every shot starts with the sidebar out; one with a side panel open folds it itself.
    await expandSidebar(page);
    await stage(shot);
    await clearLogsDot(page);
    await parkMouse(page);
    await page.waitForTimeout(300); // let the last drag's relayout paint
    console.log(`Saved ${await saveShot(name, await session.captureContent(), instance)}`);
    for (const cleanup of shot.cleanups.splice(0)) await cleanup();
  }
} catch (error) {
  // What the window showed when it failed, to see why.
  if (session) {
    const failure = `${stateDir}-failure.png`;
    try {
      await Bun.write(failure, await session.captureContent());
      console.error(`The window at the failure: ${failure}`);
    } catch (captureError) {
      console.error("Couldn't capture the window at the failure:", captureError);
    }
  }
  throw error;
} finally {
  await session?.close();
  await stopCodexDaemons();
}
