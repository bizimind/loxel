import { XIcon } from "lucide-react";

import { hostOf } from "@/components/browser/BrowserBookmarks";
import { notificationSiteDecisionSchema } from "@/electron/browser-notification-protocol";
import { useSettingsStore } from "@/store/settings-store";

export function BrowserSection() {
  const sites = useSettingsStore((s) => s.browser.notificationSites);
  const setNotificationSite = useSettingsStore((s) => s.setNotificationSite);
  const origins = Object.keys(sites).toSorted((a, b) => hostOf(a).localeCompare(hostOf(b)));

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-foreground text-sm font-medium">Browser</h3>
        <p className="text-muted-foreground mt-1 text-xs">Configure browser panels.</p>
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
