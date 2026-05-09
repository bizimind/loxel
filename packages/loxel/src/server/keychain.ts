import { randomBytes } from "node:crypto";

import { logger } from "./logger";

const log = logger.child("keychain");

const SERVICE = "com.bizimind.loxel";
const ACCOUNT = "encryption-key";
const KEY_BYTES = 32; // AES-256

const EXIT_ITEM_NOT_FOUND = 44;

async function readKey(): Promise<Buffer | null> {
  const result = await Bun.$`security find-generic-password -s ${SERVICE} -a ${ACCOUNT} -w`
    .nothrow()
    .quiet();
  if (result.exitCode === 0) return Buffer.from(result.stdout.toString().trim(), "hex");
  if (result.exitCode === EXIT_ITEM_NOT_FOUND) return null;
  throw new Error(
    `Failed to read encryption key from Keychain (exit ${result.exitCode}): ${result.stderr.toString().trim()}`,
  );
}

async function writeKey(key: Buffer): Promise<void> {
  const hex = key.toString("hex");
  // `-w` at the end (no value) reads from stdin, avoiding argv exposure in `ps`.
  // The prompt expects password + confirmation, so we send the value twice.
  const proc = Bun.spawn(
    ["security", "add-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-U", "-w"],
    { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
  );
  proc.stdin.write(`${hex}\n${hex}\n`);
  proc.stdin.end();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `Failed to store encryption key in Keychain (exit ${exitCode}): ${stderr.trim()}`,
    );
  }
}

export async function loadOrCreateKey(): Promise<Buffer> {
  const existing = await readKey();
  if (existing && existing.length === KEY_BYTES) {
    log.info("Loaded encryption key from Keychain");
    return existing;
  }

  const key = randomBytes(KEY_BYTES);
  await writeKey(key);
  log.info("Generated and stored new encryption key in Keychain");
  return key;
}
