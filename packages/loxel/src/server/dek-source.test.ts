import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDekSource } from "./dek-source";

const DEV_KEY = Buffer.from("loxel-dev-fixed-encryption-key!!", "utf8");

const dir = mkdtempSync(join(tmpdir(), "loxel-dek-source-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const keyFile = join(dir, "key");
const fileKey = Buffer.alloc(32, 7);
writeFileSync(keyFile, fileKey.toString("base64"));
const withKeyFile = { LOXEL_DEK_FILE: keyFile };

describe("createDekSource", () => {
  test("a dev or demo server from source takes the fixed key", async () => {
    const fromSource = { isDev: true, isDemo: false, isCompiled: false };
    expect(await createDekSource(fromSource, withKeyFile).loadKey()).toEqual(DEV_KEY);
    const demo = { isDev: false, isDemo: true, isCompiled: false };
    expect(await createDekSource(demo, withKeyFile).loadKey()).toEqual(DEV_KEY);
  });

  test("a compiled server never takes the fixed key, whatever mode it is told", async () => {
    for (const mode of [
      { isDev: true, isDemo: false },
      { isDev: false, isDemo: true },
    ]) {
      const key = await createDekSource({ ...mode, isCompiled: true }, withKeyFile).loadKey();
      expect(key).toEqual(fileKey);
    }
  });
});
