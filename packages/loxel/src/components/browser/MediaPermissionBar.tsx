import { MicIcon, VideoIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  MediaDevice,
  MediaPermissionRequest,
  MediaSystemBlocked,
} from "@/electron/browser-media-protocol";
import type { SitePermissionAnswer } from "@/electron/site-permission-protocol";

import { hostOf } from "./BrowserBookmarks";
import { PANEL_BAR_CLASS, SitePermissionBar } from "./SitePermissionBar";

/** "camera", "microphone", or "camera and microphone". */
function devicesLabel(devices: readonly MediaDevice[]): string {
  return devices.toSorted().join(" and ");
}

const deviceIcon = (devices: readonly MediaDevice[]) =>
  devices.includes("camera") ? VideoIcon : MicIcon;

/** A site asks to use the camera or microphone. Its `getUserMedia()` waits. */
export function MediaPermissionBar({
  request,
  onAnswer,
}: {
  request: MediaPermissionRequest;
  onAnswer: (answer: SitePermissionAnswer) => void;
}) {
  return (
    <SitePermissionBar
      icon={deviceIcon(request.devices)}
      onAllow={() => onAnswer("allow")}
      onAllowOnce={() => onAnswer("allow-once")}
      onBlock={() => onAnswer("block")}
      onDismiss={() => onAnswer("dismiss")}
    >
      <span className="font-medium">{hostOf(request.origin)}</span> wants to use your{" "}
      {devicesLabel(request.devices)}
    </SitePermissionBar>
  );
}

/**
 * The site was allowed, but macOS has Loxel's access to the device off, so the page was refused:
 * say where to turn it on. macOS may ask to quit and reopen Loxel before the change applies.
 */
export function MediaSystemBlockedBar({
  notice,
  onDismiss,
}: {
  notice: MediaSystemBlocked;
  onDismiss: () => void;
}) {
  const [first] = notice.devices.toSorted();
  const Icon = deviceIcon(notice.devices);
  return (
    <div role="alert" className={PANEL_BAR_CLASS}>
      <Icon className="text-muted-foreground size-3.5 shrink-0" />
      <span className="text-foreground min-w-0 flex-1 truncate text-xs">
        Loxel can&apos;t use your {devicesLabel(notice.devices)}: turn on Loxel in System Settings,
        then reopen Loxel if asked
      </span>
      {first && (
        <Button
          size="sm"
          className="h-6 text-xs"
          onClick={() => window.electronAPI?.openMediaSystemSettings(first)}
        >
          Open System Settings
        </Button>
      )}
      <button
        title="Dismiss"
        aria-label="Dismiss"
        className="text-muted-foreground hover:text-foreground rounded p-0.5"
        onClick={onDismiss}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
