import { SmartphoneIcon } from "lucide-react";
import { useId, useMemo, useSyncExternalStore } from "react";
import { encode } from "uqr";

import { type PasskeyQrCode, parsePasskeyQrCode } from "@/electron/passkey-qr-code";

/** Quiet zone around the code, in modules. Scanners need at least 2 on a white ground. */
const QUIET_ZONE = 2;

// The window's passkey QR codes, by webview webContents ID. Every browser panel reads this one
// store, so the window holds a single IPC subscription however many panels are open.
const requests = new Map<number, PasskeyQrCode>();
const listeners = new Set<() => void>();
let unsubscribeIpc: (() => void) | undefined;

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  unsubscribeIpc ??= window.electronAPI?.onPasskeyQrCode(
    (payload) => {
      const request = parsePasskeyQrCode(payload);
      if (!request) return;
      requests.set(request.webContentsId, request);
      notify();
    },
    (webContentsId) => {
      if (typeof webContentsId === "number" && requests.delete(webContentsId)) notify();
    },
  );
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    unsubscribeIpc?.();
    unsubscribeIpc = undefined;
    requests.clear();
  };
}

function dismiss(webContentsId: number): void {
  if (requests.delete(webContentsId)) notify();
}

/** One SVG path drawing every dark module of the code. */
function qrPath(text: string): { path: string; size: number } {
  const { data, size } = encode(text, { border: QUIET_ZONE });
  let path = "";
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    });
  });
  return { path, size };
}

/**
 * Lets the user sign in with a passkey from their phone: shows the QR code of a cross-device
 * request over the panel that made it, so a panel in the background can't put one in front of the
 * user. Hiding the code doesn't cancel the request, which other authenticators (a security key,
 * Touch ID) can still answer.
 */
export function PasskeyQrOverlay({ webContentsId }: { webContentsId: number | null }) {
  const request = useSyncExternalStore(subscribe, () =>
    webContentsId === null ? null : (requests.get(webContentsId) ?? null),
  );
  const titleId = useId();
  const qr = useMemo(() => (request ? qrPath(request.qrCode) : null), [request]);
  if (!request || !qr) return null;

  const site = request.relyingPartyId;
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/30 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-popover border-border text-foreground flex w-80 max-w-full flex-col items-center gap-3 rounded-lg border p-5 text-center shadow-2xl"
      >
        <SmartphoneIcon className="text-muted-foreground size-5" />
        <h2 id={titleId} className="text-sm font-semibold">
          Use a passkey from your phone
        </h2>
        <p className="text-muted-foreground text-xs">
          Scan this code with your phone's camera to{" "}
          {request.requestType === "create" ? "save a passkey for" : "sign in to"}{" "}
          <span className="text-foreground font-medium">{site}</span>.
        </p>
        <svg
          viewBox={`0 0 ${qr.size} ${qr.size}`}
          role="img"
          aria-label={`Passkey QR code for ${site}`}
          shapeRendering="crispEdges"
          className="size-56 rounded bg-white"
        >
          <path d={qr.path} fill="#000" />
        </svg>
        <p className="text-muted-foreground text-xs">
          Bluetooth must be on: your phone checks that it is near this computer.
        </p>
        <button
          type="button"
          onClick={() => dismiss(request.webContentsId)}
          className="text-muted-foreground hover:text-foreground hover:bg-muted rounded px-2 py-1 text-xs transition-colors"
        >
          Hide QR code
        </button>
      </div>
    </div>
  );
}
