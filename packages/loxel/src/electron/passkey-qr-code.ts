/**
 * A cross-device passkey request (FIDO hybrid transport) that a browser panel shows as a QR code.
 * Sent from main to the window hosting the panel's webview; shared by both sides, so this module
 * must stay free of Node and Electron imports.
 */
export interface PasskeyQrCode {
  /** The requesting webview's webContents ID; each browser panel shows only its own requests. */
  webContentsId: number;
  /** The site asking, shown to the user. Chromium has checked it against the page's origin. */
  relyingPartyId: string;
  requestType: "create" | "get";
  /** The `FIDO:/` URL to encode. Secret for the lifetime of the request: never log it. */
  qrCode: string;
}

export const FIDO_QR_PREFIX = "FIDO:/";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Narrow an IPC payload to a QR code request, or null when it isn't one. */
export function parsePasskeyQrCode(value: unknown): PasskeyQrCode | null {
  if (!isRecord(value)) return null;
  const { webContentsId, relyingPartyId, requestType, qrCode } = value;
  if (typeof webContentsId !== "number" || typeof relyingPartyId !== "string") return null;
  if (requestType !== "create" && requestType !== "get") return null;
  if (typeof qrCode !== "string" || !qrCode.startsWith(FIDO_QR_PREFIX)) return null;
  return { webContentsId, relyingPartyId, requestType, qrCode };
}
