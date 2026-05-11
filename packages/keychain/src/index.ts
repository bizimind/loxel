import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const addon = require("../build/Release/keychain_addon.node") as {
  getSecret(service: string, account: string): Buffer | null;
  setSecret(service: string, account: string, secret: Buffer): void;
  deleteSecret(service: string, account: string): boolean;
};

export function getSecret(service: string, account: string): Buffer | null {
  return addon.getSecret(service, account);
}

export function setSecret(service: string, account: string, secret: Buffer): void {
  addon.setSecret(service, account, secret);
}

export function deleteSecret(service: string, account: string): boolean {
  return addon.deleteSecret(service, account);
}
