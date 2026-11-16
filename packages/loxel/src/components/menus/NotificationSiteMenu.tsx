import { AlarmClockIcon, BellIcon, BellOffIcon } from "lucide-react";

import { hostOf } from "@/components/browser/BrowserBookmarks";
import {
  SNOOZE_OPTIONS,
  muteLabel,
  useActiveNotificationMutes,
} from "@/components/notifications/site-mute";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { useSettingsStore } from "@/store/settings-store";

interface NotificationSiteMenuProps {
  /** The site (origin) whose notifications the menu mutes. */
  origin: string;
  position: { x: number; y: number };
  onClose: () => void;
}

/**
 * A browser notification's context menu: snooze or mute its site, or unmute it. The site keeps its
 * Allow decision either way; only its notifications stop. Mounted only while open.
 */
export function NotificationSiteMenu({ origin, position, onClose }: NotificationSiteMenuProps) {
  const mute = useActiveNotificationMutes()[origin];
  const setNotificationMute = useSettingsStore((s) => s.setNotificationMute);

  return (
    <ContextMenu
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      position={position}
    >
      <ContextMenuLabel>
        {hostOf(origin)}
        {mute && <span className="font-normal"> · {muteLabel(mute, Date.now())}</span>}
      </ContextMenuLabel>
      <ContextMenuSeparator />
      {mute ? (
        <ContextMenuItem onClick={() => setNotificationMute(origin, null)}>
          <BellIcon />
          Unmute
        </ContextMenuItem>
      ) : (
        <>
          {SNOOZE_OPTIONS.map((option) => (
            <ContextMenuItem
              key={option.label}
              onClick={() => setNotificationMute(origin, { until: option.until(Date.now()) })}
            >
              <AlarmClockIcon />
              {option.label}
            </ContextMenuItem>
          ))}
          <ContextMenuItem onClick={() => setNotificationMute(origin, {})}>
            <BellOffIcon />
            Mute until unmuted
          </ContextMenuItem>
        </>
      )}
    </ContextMenu>
  );
}
