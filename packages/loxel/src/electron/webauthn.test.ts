import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SelectWebauthnAccountDetails, Session, WebAuthnAccount } from "electron";

import {
  APP_BUNDLE_ID,
  APPLE_TEAM_ID,
  WEBAUTHN_KEYCHAIN_ACCESS_GROUP,
  accountLabel,
  chooseAccount,
  configurePasskeys,
  embeddedProvisioningProfilePath,
  installAccountChooser,
} from "./webauthn";

const packageRoot = path.resolve(import.meta.dirname, "..", "..");

function account(credentialId: string, fields: Partial<WebAuthnAccount> = {}): WebAuthnAccount {
  return { credentialId, ...fields };
}

describe("build configuration", () => {
  test("the entitlements grant the access group the app configures", async () => {
    const plist = await Bun.file(path.join(packageRoot, "assets/entitlements.mac.plist")).text();
    expect(plist).toContain("<key>keychain-access-groups</key>");
    expect(plist).toContain(`<string>${WEBAUTHN_KEYCHAIN_ACCESS_GROUP}</string>`);
    // The identifier the provisioning profile is issued for.
    expect(plist).toContain("<key>com.apple.application-identifier</key>");
    expect(plist).toContain(`<string>${APPLE_TEAM_ID}.${APP_BUNDLE_ID}</string>`);
  });

  test("the unprovisioned entitlements grant no access group", async () => {
    const plist = await Bun.file(
      path.join(packageRoot, "assets/entitlements.mac.unprovisioned.plist"),
    ).text();
    expect(plist).not.toContain("keychain-access-groups");
  });

  test("the access group is derived from the bundle id electron-builder uses", async () => {
    const config = await Bun.file(path.join(packageRoot, "electron-builder.yml")).text();
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
    // Bundles of our own, so an installed Loxel's profile cannot leak in.
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "loxel-"));
    try {
      const provisioned = path.join(root, "provisioned", "Contents");
      fs.mkdirSync(path.join(provisioned, "Resources"), { recursive: true });
      fs.writeFileSync(path.join(provisioned, "embedded.provisionprofile"), "");
      const unprovisioned = path.join(root, "unprovisioned", "Contents");
      fs.mkdirSync(path.join(unprovisioned, "Resources"), { recursive: true });

      const calls: unknown[] = [];
      const configureWebAuthn = (options: unknown) => calls.push(options);
      // The first two have a profile, so only the platform / packaged guard can reject them.
      const hosts = [
        { platform: "linux" as const, isPackaged: true, contents: provisioned },
        { platform: "darwin" as const, isPackaged: false, contents: provisioned },
        { platform: "darwin" as const, isPackaged: true, contents: unprovisioned },
      ];
      for (const { contents, ...host } of hosts) {
        const appPath = path.join(contents, "Resources", "app.asar");
        expect(configurePasskeys({ ...host, appPath, configureWebAuthn })).toBe(false);
      }
      expect(calls).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

describe("configurePasskeys when Electron rejects the configuration", () => {
  test("logs and reports passkeys disabled instead of throwing", () => {
    const bundle = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "loxel-"));
    const originalError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      const contents = path.join(bundle, "Contents");
      fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });
      fs.writeFileSync(path.join(contents, "embedded.provisionprofile"), "");
      const enabled = configurePasskeys({
        platform: "darwin",
        isPackaged: true,
        appPath: path.join(contents, "Resources", "app.asar"),
        configureWebAuthn: () => {
          throw new Error("bad access group");
        },
      });
      expect(enabled).toBe(false);
      expect(logged).toHaveLength(1);
      expect(String(logged[0]![1])).toContain("bad access group");
    } finally {
      console.error = originalError;
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

describe("installAccountChooser", () => {
  type Listener = (
    event: unknown,
    details: SelectWebauthnAccountDetails,
    callback: (credentialId?: string | null) => void,
  ) => Promise<void>;

  /** A stand-in for the session: captures the listener so tests can fire the event. */
  function fakeSession(): { session: Session; fire: Listener } {
    let listener: Listener | undefined;
    const session = {
      on: (_event: string, fn: Listener) => {
        listener = fn;
      },
    } as unknown as Session;
    return { session, fire: (event, details, callback) => listener!(event, details, callback) };
  }

  const details = (accounts: WebAuthnAccount[]): SelectWebauthnAccountDetails => ({
    relyingPartyId: "example.com",
    accounts,
    frame: null,
  });

  test("answers with the chosen credential exactly once", async () => {
    const { session, fire } = fakeSession();
    installAccountChooser(session, () => Promise.resolve(1));
    const answers: unknown[] = [];
    await fire(null, details([account("first"), account("second")]), (id) => answers.push(id));
    expect(answers).toEqual(["second"]);
  });

  test("a failing prompt cancels the request, still exactly once", async () => {
    const { session, fire } = fakeSession();
    installAccountChooser(session, () => Promise.reject(new Error("dialog failed")));
    const originalError = console.error;
    console.error = () => {};
    try {
      const answers: unknown[] = [];
      await fire(null, details([account("first"), account("second")]), (id) => answers.push(id));
      expect(answers).toEqual([null]);
    } finally {
      console.error = originalError;
    }
  });
});
