import { BellIcon } from "lucide-react";

import type { NotificationPermissionRequest } from "@/electron/browser-notification-protocol";

import { hostOf } from "./BrowserBookmarks";
import { SitePermissionBar } from "./SitePermissionBar";
import type { NotificationPermissionAnswer } from "./useBrowserNotifications";

/** A site asks to show notifications. */
export function NotificationPermissionBar({
  request,
  onAnswer,
}: {
  request: NotificationPermissionRequest;
  onAnswer: (answer: NotificationPermissionAnswer) => void;
}) {
  return (
    <SitePermissionBar
      requestKey={JSON.stringify(request)}
      icon={BellIcon}
      onAllow={() => onAnswer("allow")}
      onBlock={() => onAnswer("block")}
      onDismiss={() => onAnswer("dismiss")}
    >
      <span className="font-medium">{hostOf(request.origin)}</span> wants to show notifications
    </SitePermissionBar>
  );
}
