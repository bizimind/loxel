import { UnplugIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { wsClient } from "@/api/client";

const isElectron = navigator.userAgent.includes("Electron");

/**
 * Shown in the top bar while the connection to the Loxel server is down. It comes back by itself
 * and the window then catches up; clicking tries again now instead of waiting.
 */
export function ConnectionIndicator() {
  const state = useSyncExternalStore(wsClient.onConnectionStateChange, wsClient.getConnectionState);
  if (state !== "reconnecting") return null;

  return (
    <button
      type="button"
      className="text-warning hover:text-warning/80 mr-1 flex items-center gap-1 rounded p-1 text-[10px] font-medium"
      onClick={() => wsClient.retryNow()}
      style={isElectron ? { WebkitAppRegion: "no-drag" } : undefined}
      title="Lost the connection to the Loxel server. Loxel reconnects by itself and catches up; click to try now."
    >
      <UnplugIcon className="size-3" aria-hidden />
      Reconnecting…
    </button>
  );
}
