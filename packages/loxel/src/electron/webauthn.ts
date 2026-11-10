import fs from "node:fs";
import path from "node:path";

import type { Session, WebAuthnAccount, WebFrameMain } from "electron";

import { PASSKEY_QR_HIDE, PASSKEY_QR_SHOW } from "./ipc-channels";
import { FIDO_QR_PREFIX, type PasskeyQrCode, isRecord } from "./passkey-qr-code";

/**
 * Passkeys in the browser panels.
 *
 * Electron ships Chromium's Web Authentication stack, but on macOS the Touch ID
 * platform authenticator stays off until the app names the keychain access
 * group its credentials live under. That group has to be granted by the
 * `keychain-access-groups` code-signing entitlement, and macOS only honours
 * that entitlement in a Developer ID build that embeds a provisioning profile
 * allowing it. A dev run or an unprovisioned build therefore configures
 * nothing, and sites fall back to security keys as before.
 */

/** Apple Developer team that signs Loxel. */
export const APPLE_TEAM_ID = "JJ88G244AR";

/** Must match `appId` in electron-builder.yml. */
export const APP_BUNDLE_ID = "com.bizimind.loxel";

/**
 * Keychain access group for WebAuthn credentials — the conventional
 * `<TEAM_ID>.<BUNDLE_ID>.webauthn`. Listed in `assets/entitlements.mac.plist`.
 */
export const WEBAUTHN_KEYCHAIN_ACCESS_GROUP = `${APPLE_TEAM_ID}.${APP_BUNDLE_ID}.webauthn`;

/** Shown as `"Loxel" is trying to <reason>`; `$1` is the site's relying party ID. */
export const WEBAUTHN_PROMPT_REASON = "sign in to $1";

/**
 * Where electron-builder places the provisioning profile inside the bundle.
 * `appPath` is `app.getAppPath()`: `<bundle>/Contents/Resources/app.asar`.
 */
export function embeddedProvisioningProfilePath(appPath: string): string {
  return path.resolve(appPath, "..", "..", "embedded.provisionprofile");
}

export interface PasskeyHost {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  appPath: string;
  configureWebAuthn: (options: {
    touchID: { keychainAccessGroup: string; promptReason: string };
  }) => void;
}

/**
 * Enable the Touch ID platform authenticator when this build can use it.
 * Call after `ready`: the prompt reason is stored in Chromium's resource
 * bundle, which does not exist before the browser process starts. Returns
 * whether it did, so the caller can log the outcome.
 */
export function configurePasskeys(host: PasskeyHost): boolean {
  if (host.platform !== "darwin" || !host.isPackaged) return false;
  if (!fs.existsSync(embeddedProvisioningProfilePath(host.appPath))) return false;
  try {
    host.configureWebAuthn({
      touchID: {
        keychainAccessGroup: WEBAUTHN_KEYCHAIN_ACCESS_GROUP,
        promptReason: WEBAUTHN_PROMPT_REASON,
      },
    });
    return true;
  } catch (err) {
    // The API declares no error contract. Launching without passkeys beats
    // not launching, so log the cause and carry on with security keys only.
    console.error("[electron] Passkeys unavailable: configureWebAuthn failed:", err);
    return false;
  }
}

/** A line the user can recognise an account by. */
export function accountLabel(account: WebAuthnAccount): string {
  const name = account.name?.trim();
  const displayName = account.displayName?.trim();
  if (name && displayName && name !== displayName) return `${displayName} (${name})`;
  return name || displayName || "Unnamed account";
}

/**
 * Pick which discoverable credential answers a `navigator.credentials.get()`.
 * One match needs no question; several are put to `prompt`, which returns the
 * index chosen or null for cancel. Returns the credential ID, or null to
 * cancel the request.
 */
export async function chooseAccount(
  accounts: readonly WebAuthnAccount[],
  prompt: (labels: string[]) => Promise<number | null>,
): Promise<string | null> {
  if (accounts.length === 0) return null;
  if (accounts.length === 1) return accounts[0]!.credentialId;
  const index = await prompt(accounts.map(accountLabel));
  if (index === null) return null;
  return accounts[index]?.credentialId ?? null;
}

/**
 * Answer account selection for a session. Without a listener Electron cancels
 * every multi-credential request with `NotAllowedError`.
 */
export function installAccountChooser(
  browserSession: Session,
  prompt: (
    frame: WebFrameMain | null,
    relyingPartyId: string,
    labels: string[],
  ) => Promise<number | null>,
): void {
  browserSession.on("select-webauthn-account", async (_event, details, callback) => {
    // Electron requires the callback exactly once, so it lives in `finally`.
    let credentialId: string | null = null;
    try {
      credentialId = await chooseAccount(details.accounts, (labels) =>
        prompt(details.frame, details.relyingPartyId, labels),
      );
    } catch (err) {
      console.error("[electron] WebAuthn account selection failed:", err);
    } finally {
      callback(credentialId);
    }
  });
}

/**
 * Cross-device passkeys: sign in with a passkey stored on a phone by scanning a QR code
 * (FIDO hybrid transport). Electron offers it through the `webauthn-hybrid-request` session
 * event (electron/electron#55427) and draws no UI, so the browser panel that made the request
 * shows the code. On an Electron without the event the listeners never fire.
 */

/** A browser panel's webview, as seen by the hybrid QR code listeners. */
export interface BrowserPanelFrame {
  webContentsId: number;
  /** Send to the renderer of the window hosting the webview. */
  send: (channel: string, payload: unknown) => void;
  /** True once the webview is destroyed. */
  isGone: () => boolean;
  /** Run `callback` once when the webview is destroyed; returns a function that stops that. */
  onGone: (callback: () => void) => () => void;
}

/**
 * The requesting frame of a hybrid event. Electron documents it as `WebFrameMain | null`; the
 * runtime check only guards against a malformed payload.
 */
function eventFrame(details: Record<string, unknown>): WebFrameMain | null {
  const { frame } = details;
  if (!isRecord(frame) || typeof frame.origin !== "string") return null;
  return frame as unknown as WebFrameMain;
}

interface PendingRequest {
  relyingPartyId: string;
  frame: WebFrameMain;
  panel: BrowserPanelFrame;
  stopWatchingPanel: () => void;
}

/** Requests a completion event without a frame belongs to: those whose frame has gone, or the lone match. */
function endedWithoutFrame(candidates: PendingRequest[]): PendingRequest[] {
  const gone = candidates.filter(({ frame, panel }) => frame.detached || panel.isGone());
  if (gone.length > 0) return gone;
  return candidates.length === 1 ? candidates : [];
}

/**
 * Show each hybrid request's QR code in the browser panel that made it. `locate` maps the
 * requesting frame to its panel, or null for a frame outside the browser panels, whose request
 * then gets no QR code and carries on with the other authenticators.
 *
 * The listeners only forward the request: Electron emits from inside Chromium's request setup,
 * so they must not block or tear down the frame.
 */
export function installHybridQrCode(
  browserSession: NodeJS.EventEmitter,
  locate: (frame: WebFrameMain) => BrowserPanelFrame | null,
): void {
  // Requests showing a QR code, by webContents ID (one WebAuthn request per page at a time).
  const pending = new Map<number, PendingRequest>();

  function end(request: PendingRequest): void {
    const { webContentsId } = request.panel;
    if (pending.get(webContentsId) !== request) return;
    pending.delete(webContentsId);
    request.stopWatchingPanel();
    request.panel.send(PASSKEY_QR_HIDE, webContentsId);
  }

  browserSession.on("webauthn-hybrid-request", (_event: unknown, details: unknown) => {
    if (!isRecord(details)) return;
    const { relyingPartyId, requestType, qrCode } = details;
    if (typeof relyingPartyId !== "string") return;
    if (requestType !== "create" && requestType !== "get") return;
    if (typeof qrCode !== "string" || !qrCode.startsWith(FIDO_QR_PREFIX)) return;
    const frame = eventFrame(details);
    const panel = frame && locate(frame);
    if (!frame || !panel) return;

    pending.get(panel.webContentsId)?.stopWatchingPanel();
    const request: PendingRequest = {
      relyingPartyId,
      frame,
      panel,
      stopWatchingPanel: panel.onGone(() => end(request)),
    };
    pending.set(panel.webContentsId, request);
    const qr: PasskeyQrCode = {
      webContentsId: panel.webContentsId,
      relyingPartyId,
      requestType,
      qrCode,
    };
    panel.send(PASSKEY_QR_SHOW, qr);
  });

  browserSession.on("webauthn-hybrid-request-completed", (_event: unknown, details: unknown) => {
    if (!isRecord(details)) return;
    const frame = eventFrame(details);
    if (frame) {
      // Only the request that frame made: not one outside the panels (a sign-in popup on the
      // same session), and not a newer request from the same webview.
      const panel = locate(frame);
      const request = panel && pending.get(panel.webContentsId);
      if (request?.frame === frame) end(request);
      return;
    }
    // The frame is usually gone when a navigation ended the request.
    const candidates = [...pending.values()].filter(
      (request) => request.relyingPartyId === details.relyingPartyId,
    );
    for (const request of endedWithoutFrame(candidates)) end(request);
  });
}
