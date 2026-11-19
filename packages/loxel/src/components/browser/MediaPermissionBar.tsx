import { MicIcon, VideoIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  MediaDevice,
  MediaPermissionAnswer,
  MediaPermissionRequest,
  MediaSystemBlocked,
} from "@/electron/browser-media-protocol";

import { hostOf } from "./BrowserBookmarks";

/** "camera", "microphone", or "camera and microphone". */
function devicesLabel(devices: readonly MediaDevice[]): string {
  return devices.toSorted().join(" and ");
}

function DeviceIcon({ devices }: { devices: readonly MediaDevice[] }) {
  const Icon = devices.includes("camera") ? VideoIcon : MicIcon;
  return <Icon className="text-muted-foreground size-3.5 shrink-0" />;
}

const BAR_CLASS = "border-border bg-muted/40 flex shrink-0 items-center gap-2 border-b px-3 py-1";

/**
 * A site asks to use the camera or microphone: a bar under the browser panel's toolbar, like the
 * notification one, so the page stays usable while the user decides. Its `getUserMedia()` waits.
 */
export function MediaPermissionBar({
  request,
  onAnswer,
}: {
  request: MediaPermissionRequest;
  onAnswer: (answer: MediaPermissionAnswer) => void;
}) {
  return (
    <div role="alert" className={BAR_CLASS}>
      <DeviceIcon devices={request.devices} />
      <span className="text-foreground min-w-0 flex-1 truncate text-xs">
        <span className="font-medium">{hostOf(request.origin)}</span> wants to use your{" "}
        {devicesLabel(request.devices)}
      </span>
      <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => onAnswer("block")}>
        Block
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 text-xs"
        onClick={() => onAnswer("allow-once")}
      >
        Allow this time
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
  return (
    <div role="alert" className={BAR_CLASS}>
      <DeviceIcon devices={notice.devices} />
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
