import { RotateCwIcon, UnplugIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { wsClient } from "@/api/client";

const isElectron = navigator.userAgent.includes("Electron");
const buttonClassName =
  "text-warning hover:text-warning/80 mr-1 flex items-center gap-1 rounded p-1 text-[10px] font-medium";
const buttonStyle = isElectron ? { WebkitAppRegion: "no-drag" as const } : undefined;

/**
 * Shown in the top bar while the connection to the Loxel server is down. It comes back by itself
 * and the window then catches up; clicking tries again now instead of waiting. When the server no
 * longer accepts the window, only a reload reconnects it, which clicking does.
 */
export function ConnectionIndicator() {
  const state = useSyncExternalStore(wsClient.onConnectionStateChange, wsClient.getConnectionState);
  if (state === "expired") {
    return (
      <button
        type="button"
        className={buttonClassName}
        onClick={() => window.location.reload()}
        style={buttonStyle}
        title="Loxel's server restarted and no longer accepts this window. Click to reload it and reconnect."
      >
        <RotateCwIcon className="size-3" aria-hidden />
        Server restarted, reload to reconnect
      </button>
    );
  }
  if (state !== "reconnecting") return null;

  return (
    <button
      type="button"
      className={buttonClassName}
      onClick={() => wsClient.retryNow()}
      style={buttonStyle}
      title="Lost the connection to the Loxel server. Loxel reconnects by itself and catches up; click to try now."
    >
      <UnplugIcon className="size-3" aria-hidden />
      Reconnecting…
    </button>
  );
}
