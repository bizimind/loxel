/**
 * Signs a CLI release manifest with the `CLI_MANIFEST_SIGNING_KEY` secret (an Ed25519 private key,
 * PKCS#8 PEM), writing the base64 signature to `<manifest>.sig`. Fails unless the signature checks
 * out against `CLI_MANIFEST_PUBLIC_KEY`, the variable release builds embed, so a secret and a
 * variable that are not a pair cannot ship. `--check` only checks the pair, before a release.
 *
 * Usage: bun packages/cli-common/scripts/sign-manifest.ts <manifest> | --check
 */
import { createPrivateKey, sign } from "node:crypto";

import {
  isManifestSignatureValid,
  MANIFEST_SIGNATURE_SUFFIX,
  publicKeyFromBase64,
} from "../src/update/manifest-signature.ts";

const [target] = process.argv.slice(2);
if (!target) throw new Error("Usage: sign-manifest.ts <manifest> | --check");

const privateKey = process.env.CLI_MANIFEST_SIGNING_KEY;
if (!privateKey) throw new Error("CLI_MANIFEST_SIGNING_KEY is not set");
const publicKey = process.env.CLI_MANIFEST_PUBLIC_KEY;
if (!publicKey) throw new Error("CLI_MANIFEST_PUBLIC_KEY is not set");

const data =
  target === "--check"
    ? new TextEncoder().encode("key pair check")
    : await Bun.file(target).bytes();
const signature = sign(null, data, createPrivateKey(privateKey)).toString("base64");

if (!isManifestSignatureValid(data, signature, publicKeyFromBase64(publicKey))) {
  throw new Error("CLI_MANIFEST_SIGNING_KEY is not the private half of CLI_MANIFEST_PUBLIC_KEY");
}

if (target !== "--check") {
  await Bun.write(`${target}${MANIFEST_SIGNATURE_SUFFIX}`, `${signature}\n`);
}
