/**
 * What browser pages in the background (other worktrees', or Home's) may cost.
 *
 * Every `REVIEW_INTERVAL_MS`, the window measures its background pages (`getBrowserPageUsage`) and
 * applies the plan `planBackgroundPages` makes for the Background Tabs setting:
 *
 * - **Freeze** a page that still uses CPU after it has been hidden for a while: its tasks and
 *   timers stop, and its memory stays. It resumes when shown. Pages that can notify, pages of this
 *   machine (dev servers, whose live-reload connection would drop), and pages playing sound or with
 *   DevTools open are never frozen.
 * - **Unload** pages while the background pages together use more memory than the budget, a share
 *   of the machine's memory. The one with the most points goes first: its memory times how long it
 *   has been hidden, so a big page left long ago goes before a small or recent one. Pages that can
 *   notify, play sound or have DevTools open go last. An unloaded page loads again when its panel
 *   is shown.
 */
import { frontendLog } from "@/lib/frontend-logger";
import { isLoopbackHost } from "@/url-utils";

import {
  backgroundBrowserPages,
  browserPageUrl,
  canNotify,
  markBrowserPageFrozen,
  unloadBrowserPages,
} from "./browser-pages";
import { type BackgroundTabsMode, useSettingsStore } from "./settings-store";

const log = frontendLog.child("ui");

/** How often background pages are measured and reviewed. */
export const REVIEW_INTERVAL_MS = 30_000;

/** CPU use, in percent of one core, at which a background page is worth freezing. */
const FREEZE_CPU_PERCENT = 1;

interface BudgetProfile {
  /** The share of the machine's memory background pages may use together. */
  memoryShare: number;
  /** How long a page is hidden before it may be frozen; null never freezes. */
  freezeAfterMs: number | null;
}

/** What each Background Tabs mode allows. */
export const BUDGET_PROFILES: Record<BackgroundTabsMode, BudgetProfile> = {
  "save-memory": { memoryShare: 0.1, freezeAfterMs: 60_000 },
  balanced: { memoryShare: 0.2, freezeAfterMs: 5 * 60_000 },
  "keep-running": { memoryShare: 0.4, freezeAfterMs: null },
};

/** A background page as the plan sees it. */
export interface PageCandidate {
  id: string;
  hiddenForMs: number;
  memoryKB: number;
  cpuPercent: number;
  frozen: boolean;
  /** Its site may notify, or it has a notification in the center. */
  canNotify: boolean;
  /** It is a page of this machine, e.g. a dev server. */
  local: boolean;
  /** It plays sound or has DevTools open. */
  inUse: boolean;
}

export interface BackgroundPagePlan {
  freeze: string[];
  unload: string[];
}

/** Which background pages to freeze and which to unload, within `profile` and `totalMemoryKB`. */
export function planBackgroundPages(
  candidates: readonly PageCandidate[],
  profile: BudgetProfile,
  totalMemoryKB: number,
): BackgroundPagePlan {
  const budgetKB = totalMemoryKB * profile.memoryShare;
  let usedKB = candidates.reduce((sum, page) => sum + page.memoryKB, 0);
  const unload: string[] = [];
  const keptLast = (page: PageCandidate) => Number(page.canNotify || page.inUse);
  const byPoints = candidates.toSorted(
    (a, b) => keptLast(a) - keptLast(b) || b.memoryKB * b.hiddenForMs - a.memoryKB * a.hiddenForMs,
  );
  for (const page of byPoints) {
    if (usedKB <= budgetKB) break;
    unload.push(page.id);
    usedKB -= page.memoryKB;
  }

  const { freezeAfterMs } = profile;
  const freeze = candidates
    .filter(
      (page) =>
        freezeAfterMs !== null &&
        !unload.includes(page.id) &&
        !page.frozen &&
        !page.canNotify &&
        !page.local &&
        !page.inUse &&
        page.hiddenForMs >= freezeAfterMs &&
        page.cpuPercent >= FREEZE_CPU_PERCENT,
    )
    .map((page) => page.id);
  return { freeze, unload };
}

function isLocalUrl(url: string): boolean {
  return URL.canParse(url) && isLoopbackHost(new URL(url).hostname);
}

/** Measure the background pages and freeze or unload what the Background Tabs setting asks. */
export async function reviewBackgroundPages(): Promise<void> {
  const api = window.electronAPI;
  const measured = backgroundBrowserPages().flatMap((page) => page.webContentsId ?? []);
  if (!api || measured.length === 0) return;
  const usage = await api.getBrowserPageUsage(measured);
  const byWebContents = new Map(usage.pages.map((page) => [page.webContentsId, page]));

  // As things are now, after the wait: a page shown, re-hidden or reloaded meanwhile is judged on
  // what it is now, and only pages measured under their current guest count.
  const now = Date.now();
  const candidates = backgroundBrowserPages().flatMap((page): PageCandidate[] => {
    const used = page.webContentsId === null ? undefined : byWebContents.get(page.webContentsId);
    if (!used) return [];
    return [
      {
        id: page.id,
        hiddenForMs: now - (page.hiddenSince ?? now),
        memoryKB: used.memoryKB,
        cpuPercent: used.cpuPercent,
        frozen: page.frozen,
        canNotify: canNotify(page),
        local: isLocalUrl(browserPageUrl(page)),
        inUse: used.inUse,
      },
    ];
  });
  const profile = BUDGET_PROFILES[useSettingsStore.getState().browser.backgroundTabs];
  const plan = planBackgroundPages(candidates, profile, usage.totalMemoryKB);

  unloadBrowserPages(plan.unload);
  const frozen = await Promise.all(plan.freeze.map(freeze));
  const frozenCount = frozen.filter(Boolean).length;
  if (frozenCount > 0 || plan.unload.length > 0) {
    log.info("Froze or unloaded background browser pages", {
      frozen: frozenCount,
      unloaded: plan.unload.length,
      backgroundMB: Math.round(candidates.reduce((sum, page) => sum + page.memoryKB, 0) / 1024),
    });
  }
}

/** Freeze panel `id`'s page if it is still in the background on the same guest. */
async function freeze(id: string): Promise<boolean> {
  const page = backgroundBrowserPages().find((candidate) => candidate.id === id);
  const webContentsId = page?.webContentsId;
  if (webContentsId === null || webContentsId === undefined || !window.electronAPI) return false;
  const frozen = await window.electronAPI.setBrowserPageFrozen(webContentsId, true);
  if (frozen) markBrowserPageFrozen(id, webContentsId);
  return frozen;
}
