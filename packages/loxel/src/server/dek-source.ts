import { createInterface } from "node:readline/promises";
import { setTimeout } from "node:timers/promises";

import { logger } from "./logger";

const log = logger.child("keychain");
const KEY_BYTES = 32;

export interface DekSource {
  loadKey(): Promise<Buffer>;
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
  async loadKey(): Promise<Buffer> {
    using reader = createInterface(process.stdin);

    const lineOrError = await Promise.race([
      new Promise<string>((resolve) => {
        reader.once("line", resolve);
      }),
      setTimeout(10_000, new Error(`No DEK received on stdin within 10s`), { ref: false }),
    ]);

    if (lineOrError instanceof Error) {
      throw lineOrError;
    }

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
