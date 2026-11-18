/**
 * A Bun macro, imported with `{ type: "macro" }`: it runs when the CLI is bundled, so the value
 * is inlined into the binary as a string literal and no environment at run time can change it.
 */

/**
 * The `CLI_MANIFEST_PUBLIC_KEY` environment variable at build time (in the release workflows, the
 * GitHub variable of that name): the release manifests' Ed25519 public key, SPKI DER in base64.
 * Empty when the build had none.
 */
export function releasePublicKeyAtBuild(): string {
  return process.env.CLI_MANIFEST_PUBLIC_KEY ?? "";
}
