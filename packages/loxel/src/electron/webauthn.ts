import fs from "node:fs";
import path from "node:path";

import type { Session, WebAuthnAccount } from "electron";

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
 * Returns whether it did, so the caller can log the outcome.
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
  prompt: (relyingPartyId: string, labels: string[]) => Promise<number | null>,
): void {
  browserSession.on("select-webauthn-account", (_event, details, callback) => {
    void chooseAccount(details.accounts, (labels) => prompt(details.relyingPartyId, labels))
      .then((credentialId) => callback(credentialId))
      .catch((err: unknown) => {
        console.error("[electron] WebAuthn account selection failed:", err);
        callback(null);
      });
  });
}
