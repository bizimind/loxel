import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WebAuthnAccount } from "electron";

import {
  APP_BUNDLE_ID,
  WEBAUTHN_KEYCHAIN_ACCESS_GROUP,
  accountLabel,
  chooseAccount,
  configurePasskeys,
  embeddedProvisioningProfilePath,
} from "./webauthn";

const packageRoot = path.resolve(import.meta.dirname, "..", "..");

function account(credentialId: string, fields: Partial<WebAuthnAccount> = {}): WebAuthnAccount {
  return { credentialId, ...fields };
}

describe("build configuration", () => {
  test("the entitlements grant the access group the app configures", () => {
    const plist = fs.readFileSync(path.join(packageRoot, "assets/entitlements.mac.plist"), "utf8");
    expect(plist).toContain("<key>keychain-access-groups</key>");
    expect(plist).toContain(`<string>${WEBAUTHN_KEYCHAIN_ACCESS_GROUP}</string>`);
  });

  test("the unprovisioned entitlements grant no access group", () => {
    const plist = fs.readFileSync(
      path.join(packageRoot, "assets/entitlements.mac.unprovisioned.plist"),
      "utf8",
    );
    expect(plist).not.toContain("keychain-access-groups");
  });

  test("the access group is derived from the bundle id electron-builder uses", () => {
    const config = fs.readFileSync(path.join(packageRoot, "electron-builder.yml"), "utf8");
    expect(config).toMatch(new RegExp(`^appId: ${APP_BUNDLE_ID.replaceAll(".", "\\.")}$`, "m"));
  });
});

describe("configurePasskeys", () => {
  const appPath = "/Applications/Loxel.app/Contents/Resources/app.asar";

  test("resolves the profile electron-builder embeds next to Resources", () => {
    expect(embeddedProvisioningProfilePath(appPath)).toBe(
      "/Applications/Loxel.app/Contents/embedded.provisionprofile",
    );
  });

  test("configures nothing off macOS, in dev, or without a provisioning profile", () => {
    const calls: unknown[] = [];
    const configureWebAuthn = (options: unknown) => calls.push(options);
    expect(
      configurePasskeys({ platform: "linux", isPackaged: true, appPath, configureWebAuthn }),
    ).toBe(false);
    expect(
      configurePasskeys({ platform: "darwin", isPackaged: false, appPath, configureWebAuthn }),
    ).toBe(false);
    // Packaged on macOS, but this path has no embedded.provisionprofile.
    expect(
      configurePasskeys({ platform: "darwin", isPackaged: true, appPath, configureWebAuthn }),
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  test("configures the Touch ID authenticator for a provisioned macOS build", () => {
    const bundle = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "loxel-"));
    try {
      const contents = path.join(bundle, "Contents");
      fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });
      fs.writeFileSync(path.join(contents, "embedded.provisionprofile"), "");
      const calls: unknown[] = [];
      const enabled = configurePasskeys({
        platform: "darwin",
        isPackaged: true,
        appPath: path.join(contents, "Resources", "app.asar"),
        configureWebAuthn: (options) => calls.push(options),
      });
      expect(enabled).toBe(true);
      expect(calls).toEqual([
        {
          touchID: {
            keychainAccessGroup: WEBAUTHN_KEYCHAIN_ACCESS_GROUP,
            promptReason: "sign in to $1",
          },
        },
      ]);
    } finally {
      fs.rmSync(bundle, { recursive: true, force: true });
    }
  });
});

describe("accountLabel", () => {
  test("combines display name and account name when they differ", () => {
    expect(accountLabel(account("a", { name: "ori@example.com", displayName: "Ori" }))).toBe(
      "Ori (ori@example.com)",
    );
  });

  test("uses whichever single name is present", () => {
    expect(accountLabel(account("a", { name: "ori@example.com" }))).toBe("ori@example.com");
    expect(accountLabel(account("a", { displayName: "Ori" }))).toBe("Ori");
    expect(accountLabel(account("a", { name: "Ori", displayName: "Ori" }))).toBe("Ori");
  });

  test("falls back for an account with no names", () => {
    expect(accountLabel(account("a", { name: " " }))).toBe("Unnamed account");
  });
});

describe("chooseAccount", () => {
  const never = () => Promise.reject(new Error("prompt should not be shown"));

  test("a single account is chosen without asking", async () => {
    expect(await chooseAccount([account("only")], never)).toBe("only");
  });

  test("no accounts cancels the request", async () => {
    expect(await chooseAccount([], never)).toBeNull();
  });

  test("several accounts are put to the prompt by label", async () => {
    const accounts = [
      account("first", { name: "a@example.com" }),
      account("second", { name: "b@example.com" }),
    ];
    let shown: string[] = [];
    const credentialId = await chooseAccount(accounts, (labels) => {
      shown = labels;
      return Promise.resolve(1);
    });
    expect(shown).toEqual(["a@example.com", "b@example.com"]);
    expect(credentialId).toBe("second");
  });

  test("cancelling or an out-of-range answer cancels the request", async () => {
    const accounts = [account("first"), account("second")];
    expect(await chooseAccount(accounts, () => Promise.resolve(null))).toBeNull();
    expect(await chooseAccount(accounts, () => Promise.resolve(7))).toBeNull();
  });
});
