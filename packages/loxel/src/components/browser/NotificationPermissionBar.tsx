import { BellIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { NotificationPermissionRequest } from "@/electron/browser-notification-protocol";

import { hostOf } from "./BrowserBookmarks";
import type { NotificationPermissionAnswer } from "./useBrowserNotifications";

/**
 * A site asks to show notifications: a bar under the browser panel's toolbar, which leaves the
 * page usable (unlike its dialogs), so the user can answer when they like.
 */
export function NotificationPermissionBar({
  request,
  onAnswer,
}: {
  request: NotificationPermissionRequest;
  onAnswer: (answer: NotificationPermissionAnswer) => void;
}) {
  return (
    <div
      role="alert"
      className="border-border bg-muted/40 flex shrink-0 items-center gap-2 border-b px-3 py-1"
    >
      <BellIcon className="text-muted-foreground size-3.5 shrink-0" />
      <span className="text-foreground min-w-0 flex-1 truncate text-xs">
        <span className="font-medium">{hostOf(request.origin)}</span> wants to show notifications
      </span>
      <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => onAnswer("block")}>
        Block
      </Button>
      <Button size="sm" className="h-6 text-xs" onClick={() => onAnswer("allow")}>
        Allow
      </Button>
      <button
        title="Not now"
        aria-label="Not now"
        className="text-muted-foreground hover:text-foreground rounded p-0.5"
        onClick={() => onAnswer("dismiss")}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
