import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { hostOf } from "@/components/browser/BrowserBookmarks";
import { Input } from "@/components/ui/input";
import { notificationSiteDecisionSchema } from "@/electron/browser-notification-protocol";
import {
  DEFAULT_BROWSER_BACKGROUND_PAGES,
  MAX_BROWSER_BACKGROUND_PAGES,
  parseBackgroundPages,
  useSettingsStore,
} from "@/store/settings-store";

export function BrowserSection() {
  const sites = useSettingsStore((s) => s.browser.notificationSites);
  const setNotificationSite = useSettingsStore((s) => s.setNotificationSite);
  const origins = Object.keys(sites).toSorted((a, b) => hostOf(a).localeCompare(hostOf(b)));
  const backgroundPages = useSettingsStore((s) => s.browser.backgroundPages);
  const setBackgroundPages = useSettingsStore((s) => s.setBrowserBackgroundPages);

  // Typed freely, committed on blur; an invalid count goes back to the saved one.
  const [pagesInput, setPagesInput] = useState(String(backgroundPages));
  useEffect(() => setPagesInput(String(backgroundPages)), [backgroundPages]);
  const commitPages = () => {
    const typed = pagesInput.trim();
    const count = typed === "" ? null : parseBackgroundPages(Number(typed));
    if (count === null) setPagesInput(String(backgroundPages));
    else setBackgroundPages(count);
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-foreground text-sm font-medium">Browser</h3>
        <p className="text-muted-foreground mt-1 text-xs">Configure browser panels.</p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="browser-background-pages" className="text-muted-foreground text-xs">
          Background Tabs
        </label>
        <p className="text-muted-foreground text-[10px]">
          How many browser tabs of other tasks, or of Home, keep running while you work elsewhere,
          so they keep their state and can notify. Past this, the tabs you saw least recently reload
          when you come back, starting with sites that can't notify. 0 reloads them every time.
          Default: {DEFAULT_BROWSER_BACKGROUND_PAGES}.
        </p>
        <Input
          id="browser-background-pages"
          type="number"
          value={pagesInput}
          onChange={(e) => setPagesInput(e.target.value)}
          onBlur={commitPages}
          min={0}
          max={MAX_BROWSER_BACKGROUND_PAGES}
          className="h-8 w-32 text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-muted-foreground text-xs">Notifications</label>
        <p className="text-muted-foreground text-[10px]">
          Sites you allowed show their notifications in the notification center, with a badge on
          their tab and worktree. Remove a site to have it ask again.
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
