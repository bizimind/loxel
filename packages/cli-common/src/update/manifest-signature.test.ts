import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { isManifestSignatureValid, publicKeyFromBase64 } from "./manifest-signature.ts";
import { fetchManifest } from "./manifest.ts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const manifest = encode({
  package: "wt",
  version: "1.2.3",
  released_at: "2026-11-18T00:00:00Z",
  binaries: { "linux-x64": { url: "https://example.com/wt", sha256: "ab".repeat(32) } },
});
const signatureOf = (data: Uint8Array, key: KeyObject = privateKey) =>
  sign(null, data, key).toString("base64");

describe("isManifestSignatureValid", () => {
  test("accepts the signature of the exact bytes", () => {
    expect(isManifestSignatureValid(manifest, `${signatureOf(manifest)}\n`, publicKey)).toBe(true);
  });

  test("rejects a manifest changed after signing", () => {
    const tampered = manifest.slice();
    tampered[10] = (tampered[10] ?? 0) ^ 1;
    expect(isManifestSignatureValid(tampered, signatureOf(manifest), publicKey)).toBe(false);
  });

  test("rejects a signature by another key", () => {
    const signature = signatureOf(manifest, other.privateKey);
    expect(isManifestSignatureValid(manifest, signature, publicKey)).toBe(false);
  });

  test("rejects a malformed signature", () => {
    expect(isManifestSignatureValid(manifest, "", publicKey)).toBe(false);
    expect(isManifestSignatureValid(manifest, "not a signature", publicKey)).toBe(false);
  });
});

describe("publicKeyFromBase64", () => {
  test("reads an Ed25519 key in the form the variable holds", () => {
    const base64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const key = publicKeyFromBase64(base64);
    expect(isManifestSignatureValid(manifest, signatureOf(manifest), key)).toBe(true);
  });

  test("rejects another kind of key", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    const base64 = rsa.export({ format: "der", type: "spki" }).toString("base64");
    expect(() => publicKeyFromBase64(base64)).toThrow("Expected an Ed25519 public key");
  });
});

describe("fetchManifest", () => {
  let body = manifest;
  let signature: string | null = signatureOf(manifest);
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/manifest.json") return new Response(body);
      if (pathname === "/manifest.json.sig" && signature !== null) return new Response(signature);
      return new Response("not found", { status: 404 });
    },
  });
  afterAll(() => server.stop(true));
  const url = new URL("/manifest.json", server.url).href;

  const serve = (data: typeof manifest, sig: string | null) => {
    body = data;
    signature = sig;
  };

  test("returns a manifest signed by the given key", async () => {
    serve(manifest, signatureOf(manifest));
    expect((await fetchManifest(url, "wt", publicKey)).version).toBe("1.2.3");
  });

  test("rejects a manifest signed by another key", async () => {
    serve(manifest, signatureOf(manifest, other.privateKey));
    await expect(fetchManifest(url, "wt", publicKey)).rejects.toThrow(
      "not signed by the release key",
    );
  });

  test("rejects a manifest without a signature", async () => {
    serve(manifest, null);
    await expect(fetchManifest(url, "wt", publicKey)).rejects.toThrow(
      "Failed to fetch update manifest signature: 404",
    );
  });

  test("rejects another package's signed manifest", async () => {
    serve(manifest, signatureOf(manifest));
    await expect(fetchManifest(url, "code-analysis", publicKey)).rejects.toThrow(
      "is the manifest of wt, not code-analysis",
    );
  });

  test("rejects a signed manifest whose checksum is not a SHA-256", async () => {
    const malformed = encode({
      package: "wt",
      version: "1.2.3",
      released_at: "2026-11-18T00:00:00Z",
      binaries: { "linux-x64": { url: "https://example.com/wt", sha256: "" } },
    });
    serve(malformed, signatureOf(malformed));
    await expect(fetchManifest(url, "wt", publicKey)).rejects.toThrow("Invalid manifest format");
  });
});
