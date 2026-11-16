import { XIcon } from "lucide-react";

import { hostOf } from "@/components/browser/BrowserBookmarks";
import { muteLabel, useActiveNotificationMutes } from "@/components/notifications/site-mute";
import { notificationSiteDecisionSchema } from "@/electron/browser-notification-protocol";
import { BUDGET_PROFILES } from "@/store/browser-page-budget";
import {
  BACKGROUND_TABS_MODES,
  type BackgroundTabsMode,
  isBackgroundTabsMode,
  useSettingsStore,
} from "@/store/settings-store";

const MODE_LABELS: Record<BackgroundTabsMode, string> = {
  "save-memory": "Save memory",
  balanced: "Balanced",
  "keep-running": "Keep running",
};

/** What a Background Tabs mode allows, from its budget (see store/browser-page-budget.ts). */
function modeHint(mode: BackgroundTabsMode): string {
  const { memoryShare, freezeAfterMs } = BUDGET_PROFILES[mode];
  const minutes = freezeAfterMs === null ? null : Math.round(freezeAfterMs / 60_000);
  const pause =
    minutes === null
      ? "Tabs never pause."
      : `Busy tabs pause after ${minutes === 1 ? "a minute" : `${minutes} minutes`}.`;
  return `Up to ${Math.round(memoryShare * 100)}% of this Mac's memory. ${pause}`;
}

export function BrowserSection() {
  const sites = useSettingsStore((s) => s.browser.notificationSites);
  const setNotificationSite = useSettingsStore((s) => s.setNotificationSite);
  const setNotificationMute = useSettingsStore((s) => s.setNotificationMute);
  const mutes = useActiveNotificationMutes();
  const origins = Object.keys(sites).toSorted((a, b) => hostOf(a).localeCompare(hostOf(b)));
  const backgroundTabs = useSettingsStore((s) => s.browser.backgroundTabs);
  const setBackgroundTabs = useSettingsStore((s) => s.setBackgroundTabs);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-foreground text-sm font-medium">Browser</h3>
        <p className="text-muted-foreground mt-1 text-xs">Configure browser panels.</p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="browser-background-tabs" className="text-muted-foreground text-xs">
          Background Tabs
        </label>
        <p className="text-muted-foreground text-[10px]">
          Browser tabs of other tasks, or of Home, keep running while you work elsewhere. Past the
          memory limit, the biggest tabs you haven&apos;t seen for longest are unloaded and reload
          when you come back. Tabs that keep using CPU are paused. Tabs that can notify you are
          unloaded last. Those tabs, pages on this Mac (dev servers), tabs playing sound and tabs
          with DevTools open are never paused.
        </p>
        <select
          id="browser-background-tabs"
          value={backgroundTabs}
          onChange={(e) => {
            if (isBackgroundTabsMode(e.target.value)) setBackgroundTabs(e.target.value);
          }}
          className="border-input bg-background text-foreground block h-7 rounded border px-1 text-xs"
        >
          {BACKGROUND_TABS_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {MODE_LABELS[mode]}
            </option>
          ))}
        </select>
        <p className="text-muted-foreground text-[10px]">{modeHint(backgroundTabs)}</p>
      </div>

      <div className="space-y-1.5">
        <label className="text-muted-foreground text-xs">Notifications</label>
        <p className="text-muted-foreground text-[10px]">
          Sites you allowed show their notifications in the notification center, with a badge on
          their tab and worktree. Right-click a site's notification to mute or snooze it. Remove a
          site to have it ask again.
        </p>
        {origins.length === 0 ? (
          <p className="text-muted-foreground pt-1 text-xs">No sites have asked yet.</p>
        ) : (
          <div className="space-y-1 pt-1">
            {origins.map((origin) => (
              <div key={origin} className="flex items-center gap-2">
                <span className="text-foreground min-w-0 flex-1 truncate text-xs" title={origin}>
                  {hostOf(origin)}
                </span>
                {mutes[origin] && (
                  <>
                    <span className="text-muted-foreground shrink-0 text-[10px]">
                      {muteLabel(mutes[origin], Date.now())}
                    </span>
                    <button
                      aria-label={`Unmute ${hostOf(origin)}`}
                      className="text-muted-foreground hover:text-foreground shrink-0 rounded px-1 text-[10px] underline-offset-2 hover:underline"
                      onClick={() => setNotificationMute(origin, null)}
                    >
                      Unmute
                    </button>
                  </>
                )}
                <select
                  aria-label={`Notifications from ${hostOf(origin)}`}
                  value={sites[origin]}
                  onChange={(e) => {
                    const decision = notificationSiteDecisionSchema.safeParse(e.target.value);
                    if (decision.success) setNotificationSite(origin, decision.data);
                  }}
                  className="border-input bg-background text-foreground block h-7 rounded border px-1 text-xs"
                >
                  <option value="allow">Allow</option>
                  <option value="block">Block</option>
                </select>
                <button
                  title="Remove"
                  aria-label={`Remove ${hostOf(origin)}`}
                  className="text-muted-foreground hover:text-foreground rounded p-1"
                  onClick={() => setNotificationSite(origin, null)}
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
