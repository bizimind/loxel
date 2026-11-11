/**
 * Shared plumbing for theme screenshots. Each file in `panels/` exports a `PanelShot` that stages
 * one panel or area of Loxel; `shoot.ts` runs it in a fresh headless Chromium context (so the
 * window starts from the default layout) against the stack started by `stack.sh`.
 */
import { resolve } from "node:path";

import type { Locator, Page } from "@playwright/test";

export const BASE_URL = "http://127.0.0.1:5173";
export const SERVER_URL = "http://127.0.0.1:7434";

export interface ShotContext {
  page: Page;
  /** Absolute path of the fixture repo (see fixture.ts). */
  fixture: string;
  /** This page's window ID, for server calls that target a window. */
  windowId: string;
  /** Open a fixture file (path relative to the repo) the way `loxel <file>` does. */
  open: (relativePath: string) => Promise<void>;
  /** Open a terminal panel in the fixture and type `command` into its shell. */
  openTerminal: (command?: string) => Promise<void>;
  /** Run a command-palette action by its visible name. */
  runCommand: (name: string) => Promise<void>;
  /** Call the Loxel server API directly (JSON in and out). */
  api: (path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;
  /** Wait for network, fonts and two animation frames. */
  settle: () => Promise<void>;
}

export interface PanelShot {
  /** One-line description of what the shot shows; shown in the report. */
  description: string;
  /** Stage the panel. Return a locator to clip the screenshot to it, or nothing for the window. */
  run: (ctx: ShotContext) => Promise<Locator | void>;
}

export function fixturePath(workDir: string): string {
  return resolve(workDir, "fixture/orbit-shop");
}

/** Store key holding the token `seed.ts` gives the stack's server; the work dir keeps a copy. */
export const STACK_TOKEN_KEY = "theme-stack-token";

export function stackTokenPath(workDir: string): string {
  return resolve(workDir, "stack-token");
}

/**
 * Throw unless the server on SERVER_URL is the theme stack started with `workDir`. Shots seed
 * settings, add the fixture project and clear notifications, so they must never reach a
 * developer's own dev server on the same port.
 */
export async function assertThemeStack(workDir: string): Promise<void> {
  const expected = await Bun.file(stackTokenPath(workDir))
    .text()
    .catch(() => null);
  const stored = (await api(`/api/stores/${STACK_TOKEN_KEY}`).catch(() => null)) as {
    value?: unknown;
  } | null;
  if (expected === null || stored?.value !== expected) {
    throw new Error(
      `${SERVER_URL} is not the theme stack started with ${workDir}; start it with e2e/theme/stack.sh`,
    );
  }
}

export async function api(path: string, init?: { method?: string; body?: unknown }) {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
    headers: init?.body === undefined ? {} : { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${text}`);
  return text ? (JSON.parse(text) as unknown) : null;
}

/** Load Loxel, activate the fixture project and wait for the center dockview. */
export async function waitForLoxel(page: Page): Promise<void> {
  await page.goto(BASE_URL);
  await page.getByText("Loxel").first().waitFor({ state: "visible" });
  await settle(page);
  const gitButton = page.locator('[title="Git"]').first();
  if (!(await gitButton.isVisible())) {
    const sidebar = page.locator(".border-border.flex.flex-col.border-r").first();
    const firstProject = sidebar
      .locator(
        'button[title]:not([title="Add project"]):not([title="Collapse sidebar"]):not([title="Expand sidebar"])',
      )
      .first();
    await firstProject.waitFor({ state: "visible", timeout: 15_000 });
    await firstProject.click();
    await gitButton.waitFor({ state: "visible", timeout: 15_000 });
  }
  await page
    .getByRole("button", { name: "New Terminal" })
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await settle(page);
}

const pending = new WeakMap<Page, Set<unknown>>();

/** Track in-flight HTTP requests (Vite's HMR socket never idles, so `networkidle` can't be used). */
export function trackRequests(page: Page): void {
  const inflight = new Set<unknown>();
  pending.set(page, inflight);
  page.on("request", (r) => inflight.add(r));
  page.on("requestfinished", (r) => inflight.delete(r));
  page.on("requestfailed", (r) => inflight.delete(r));
}

/** Wait until no HTTP request has been in flight for 400 ms (at most 10 s), then fonts and paint. */
export async function settle(page: Page): Promise<void> {
  const inflight = pending.get(page);
  if (inflight) {
    const deadline = Date.now() + 10_000;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      if (inflight.size > 0) quietSince = Date.now();
      else if (Date.now() - quietSince >= 400) break;
      await page.waitForTimeout(50);
    }
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => {
      requestAnimationFrame(() => requestAnimationFrame(r));
    });
  });
}
