import { logger } from "./logger";

const log = logger.child("keychain");
const KEY_BYTES = 32;

export interface DekSource {
  loadKey(): Promise<Buffer>;
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
    const line = await readLineFromStdin(10_000);
    const key = Buffer.from(line, "base64");
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

async function readLineFromStdin(timeoutMs: number): Promise<string> {
  const stream = Bun.stdin.stream();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`No DEK received on stdin within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      chunks.push(value);
      const combined = Buffer.concat(chunks);
      const newlineIdx = combined.indexOf(0x0a);
      if (newlineIdx !== -1) {
        return combined.subarray(0, newlineIdx).toString("utf8").trim();
      }
    }
  } finally {
    clearTimeout(timer!);
    reader.cancel();
  }

  const remaining = Buffer.concat(chunks).toString("utf8").trim();
  if (remaining.length === 0) {
    throw new Error("No DEK received on stdin — is the server running under Electron?");
  }
  return remaining;
}
