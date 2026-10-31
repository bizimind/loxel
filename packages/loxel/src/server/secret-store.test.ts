import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "secret-store-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

const KEY = Buffer.alloc(32, 7).toString("base64");

/**
 * Starts the secret store in a process of its own, which is where the key source reads stdin and
 * the environment, and reports what came of it. `stdin` undefined closes it without a line.
 */
async function startSecretStore(env: Record<string, string>, stdin?: string) {
  const script = `
    const { initSecretStore, isSecretStoreAvailable, encrypt, decrypt } = await import(${JSON.stringify(join(import.meta.dir, "secret-store.ts"))});
    await initSecretStore();
    let roundTrip = null, error = null;
    try { roundTrip = decrypt(encrypt("hello")); } catch (e) { error = e.message; }
    console.log(JSON.stringify({ available: isSecretStoreAvailable(), roundTrip, error }));
    process.exit(0);
  `;
  const { LOXEL_DEV: _dev, LOXEL_DEK_FILE: _file, ...inherited } = process.env;
  const child = Bun.spawn(["bun", "-e", script], {
    env: { ...inherited, LOXEL_STATE_DIR: dir, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  if (stdin !== undefined) await child.stdin.write(stdin);
  await child.stdin.end();
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return JSON.parse(output.trim().split("\n").at(-1) ?? "") as {
    available: boolean;
    roundTrip: string | null;
    error: string | null;
  };
}

const UNAVAILABLE = {
  available: false,
  roundTrip: null,
  error: "Secret storage is unavailable: this run has no data encryption key",
};

describe("secret storage", () => {
  test("works with a key on stdin", async () => {
    expect(await startSecretStore({}, `${KEY}\n`)).toEqual({
      available: true,
      roundTrip: "hello",
      error: null,
    });
  });

  test("is unavailable when stdin closes with no key, as Electron does without a keychain", async () => {
    expect(await startSecretStore({})).toEqual(UNAVAILABLE);
  });

  test("is unavailable, not fatal, when a key is malformed", async () => {
    expect(await startSecretStore({}, "c2hvcnQ=\n")).toEqual(UNAVAILABLE);
  });

  test("is unavailable, not fatal, when a key file is missing", async () => {
    expect(await startSecretStore({ LOXEL_DEK_FILE: join(dir, "missing") })).toEqual(UNAVAILABLE);
  });

  test("works with a key file", async () => {
    const file = join(dir, "dek");
    await Bun.write(file, KEY);
    expect((await startSecretStore({ LOXEL_DEK_FILE: file })).roundTrip).toBe("hello");
  });
});
