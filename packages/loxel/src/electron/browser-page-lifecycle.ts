/**
 * What the renderer's background browser pages cost, and freezing them. The window decides which
 * pages to freeze or unload (`store/browser-page-budget.ts`); this module measures pages and
 * freezes them, only for webviews the asking window hosts.
 */
import { app, type WebContents, webContents } from "electron";

import { handleAppWindowInvoke } from "./app-windows";
import type { BrowserPagesUsage } from "./browser-page-protocol";
import { hostedWebview } from "./hosted-webview";
import { BROWSER_PAGE_SET_FROZEN, BROWSER_PAGE_USAGE } from "./ipc-channels";

/**
 * Each renderer process's CPU time (seconds) at its previous measurement, so a page's CPU use is
 * averaged over the time between two measurements, whatever else reads the app's metrics.
 */
const previousCpu = new Map<number, { cpuSeconds: number; at: number }>();

/** A process's CPU use, in percent of one core, since its previous measurement. */
function cpuPercentSince(pid: number, cpuSeconds: number, at: number): number {
  const previous = previousCpu.get(pid);
  previousCpu.set(pid, { cpuSeconds, at });
  if (!previous || at <= previous.at) return 0;
  return ((cpuSeconds - previous.cpuSeconds) / ((at - previous.at) / 1000)) * 100;
}

function measure(host: WebContents, ids: readonly unknown[]): BrowserPagesUsage {
  const at = Date.now();
  const metrics = new Map(app.getAppMetrics().map((m) => [m.pid, m]));
  for (const pid of previousCpu.keys()) {
    if (!metrics.has(pid)) previousCpu.delete(pid);
  }
  // Webviews of one site can share a renderer process: they split its memory and CPU.
  const sharing = new Map<number, number>();
  for (const wc of webContents.getAllWebContents()) {
    if (wc.getType() !== "webview") continue;
    const pid = wc.getOSProcessId();
    sharing.set(pid, (sharing.get(pid) ?? 0) + 1);
  }
  const cpuByPid = new Map<number, number>();
  const pages = ids.flatMap((id) => {
    const guest = hostedWebview(host, id);
    const pid = guest?.getOSProcessId();
    const metric = pid === undefined ? undefined : metrics.get(pid);
    if (!guest || pid === undefined || !metric) return [];
    if (!cpuByPid.has(pid)) {
      cpuByPid.set(pid, cpuPercentSince(pid, metric.cpu.cumulativeCPUUsage ?? 0, at));
    }
    const share = sharing.get(pid) ?? 1;
    return [
      {
        webContentsId: guest.id,
        memoryKB: Math.round(metric.memory.workingSetSize / share),
        cpuPercent: (cpuByPid.get(pid) ?? 0) / share,
        inUse: guest.isCurrentlyAudible() || guest.isDevToolsOpened(),
      },
    ];
  });
  return { totalMemoryKB: process.getSystemMemoryInfo().total, pages };
}

/**
 * Each guest's last freeze or resume, so they run in the order the window asked: a page shown just
 * after it was asked to freeze is resumed after the freeze lands, not before.
 */
const lastChange = new WeakMap<WebContents, Promise<boolean>>();

/**
 * Freeze a page (Chromium's Page Lifecycle freeze: its tasks and timers stop, its memory stays) or
 * resume it, through the DevTools protocol, which is attached only while the page is frozen.
 * Chromium hides a page it freezes and doesn't show it again on resume: the window shows it again
 * itself. Resolves whether the page is now in the asked state.
 */
async function setFrozen(guest: WebContents, frozen: boolean): Promise<boolean> {
  const { debugger: protocol } = guest;
  if (!frozen) {
    if (!protocol.isAttached()) return true;
    await protocol.sendCommand("Page.setWebLifecycleState", { state: "active" });
    protocol.detach();
    return true;
  }
  // DevTools opened since the page was measured: the user is inspecting it.
  if (guest.isDevToolsOpened()) return false;
  if (!protocol.isAttached()) protocol.attach("1.3");
  try {
    await protocol.sendCommand("Page.setWebLifecycleState", { state: "frozen" });
    return true;
  } catch (error) {
    protocol.detach();
    throw error;
  }
}

export function installBrowserPageLifecycle(): void {
  handleAppWindowInvoke(BROWSER_PAGE_USAGE, (event, ids: unknown): BrowserPagesUsage => {
    return measure(event.sender, Array.isArray(ids) ? ids : []);
  });
  handleAppWindowInvoke(BROWSER_PAGE_SET_FROZEN, (event, id: unknown, frozen: unknown) => {
    const guest = hostedWebview(event.sender, id);
    if (!guest || typeof frozen !== "boolean") return false;
    const change = (lastChange.get(guest) ?? Promise.resolve(true))
      .catch(() => false)
      .then(() => setFrozen(guest, frozen))
      .catch((error: unknown) => {
        console.warn(`[browser] Could not ${frozen ? "freeze" : "resume"} a browser page:`, error);
        return false;
      });
    lastChange.set(guest, change);
    return change;
  });
}
