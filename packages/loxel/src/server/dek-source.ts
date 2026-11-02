import { createInterface } from "node:readline/promises";
import { setTimeout } from "node:timers/promises";

import { logger } from "./logger";

const log = logger.child("keychain");
const KEY_BYTES = 32;

export interface DekSource {
  /** Resolves to null when the source has no key to give; throws when it fails to give one. */
  loadKey(): Promise<Buffer | null>;
}

export function createDekSource(): DekSource {
  if (process.env.LOXEL_DEV === "1") {
    return new DevDekSource();
  }
  const dekFile = process.env.LOXEL_DEK_FILE;
  if (dekFile) {
    return new SecretFileDekSource(dekFile);
  }
  return new StdinDekSource();
}

function validateKey(key: Buffer, source: string): Buffer {
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `DEK from ${source} has unexpected length: ${key.length} (expected ${KEY_BYTES})`,
    );
  }
  return key;
}

class DevDekSource implements DekSource {
  private static readonly DEV_KEY = Buffer.from("loxel-dev-fixed-encryption-key!!", "utf8");

  async loadKey(): Promise<Buffer> {
    log.info("Using dev-mode fixed encryption key");
    return DevDekSource.DEV_KEY;
  }
}

class StdinDekSource implements DekSource {
  async loadKey(): Promise<Buffer | null> {
    using reader = createInterface(process.stdin);

    // Electron closes stdin without writing a key when the system keychain is unavailable.
    const lineOrError = await Promise.race([
      new Promise<string | null>((resolve) => {
        reader.once("line", resolve);
        reader.once("close", () => resolve(null));
      }),
      setTimeout(10_000, new Error(`No DEK received on stdin within 10s`), { ref: false }),
    ]);

    if (lineOrError instanceof Error) {
      throw lineOrError;
    }

    if (!lineOrError) return null;

    const key = Buffer.from(lineOrError, "base64");
    log.info("Loaded data encryption key from stdin");
    return validateKey(key, "stdin");
  }
}

class SecretFileDekSource implements DekSource {
  constructor(private readonly filePath: string) {}

  async loadKey(): Promise<Buffer> {
    const file = Bun.file(this.filePath);
    if (!(await file.exists())) {
      throw new Error(`DEK file not found: ${this.filePath}`);
    }
    const raw = (await file.text()).trim();
    const key = Buffer.from(raw, "base64");
    log.info("Loaded data encryption key from file");
    return validateKey(key, `file ${this.filePath}`);
  }
}
