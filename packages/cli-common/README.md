# cli-common

Shared building blocks for the monorepo's Bun CLIs: command output handling, human-readable formatters, and the self-update system for compiled binaries. Used by [wt](../wt), [excalidraw](../excalidraw), and [code-analysis](../code-analysis).

Workspace-only; add `"@bizimind/cli-common": "workspace:*"` and import from `@bizimind/cli-common`. Everything public is exported from [`src/index.ts`](src/index.ts), including a re-export of Commander's `Command` so all CLIs share one Commander version.

## Command results and output modes

Commands return a `CommandResult<T>` (data, a human formatter, and an exit code) and run through `runAction()` / `runActionSync()`, which pick `json`, `human`, or `quiet` mode from the `--json` / `--quiet` flags, print the result, and set `process.exitCode`. An action that throws prints an error result (`{ error: true, message }` in JSON mode) and exits with the error's `code` when that is a positive integer, otherwise 1. Progress output goes through the `OutputContext` passed to the action, so JSON stdout stays clean (progress is sent to stderr in JSON mode and suppressed in quiet mode).

```typescript
program
  .command("status")
  .option("--json")
  .action(async (opts) => {
    await runAction(opts, async (ctx) => {
      ctx.log("Checking...");
      const data = await getStatus();
      return createResult(data, (d) => formatKeyValue(d));
    });
  });
```

Formatters: `formatTable`, `formatKeyValue`, `formatList`, `formatSection(s)`, `formatStatus`, `formatDuration` (`src/formatters.ts`).

## Self-update

`createUpdateSystem({ packageName, getCurrentVersion, ... })` checks `https://loxel.bizimind.io/<packageName>/manifest.json`, downloads the binary for the current platform, verifies it (see [Release signing](#release-signing)), and replaces the running executable. Update checks can be cached (default TTL 1 hour, under `~/.local/state/loxel/<packageName>`). Built on top of it:

- `createVersionCommand(config)` / `createUpdateCommand(config)` — ready-made `version` and `update` subcommands
- `maybeAutoUpdate(config, argv)` — update before running a command and re-execute it with the new binary. Best effort: when the update fails it prints one line, runs the command on the installed binary, and waits for the cache TTL before trying again

`update --force` reinstalls the latest release but never installs an older version than the running one.

### Release signing

An update is installed only when these checks pass, so write access to the bucket that serves releases is not enough to ship a binary:

- **Signed manifest, all platforms.** The release workflow signs `manifest.json` with Ed25519 and publishes the base64 signature beside it as `manifest.json.sig`. Before reading the manifest, the binary checks the signature against the public key embedded in it at build time ([`manifest-signature.ts`](src/update/manifest-signature.ts), through the [`release-key.ts`](src/update/release-key.ts) Bun macro). It then checks that the manifest's `package` is its own and that the download matches the manifest's SHA-256.
- **Developer ID, macOS.** [`scripts/codesign-release.ts`](scripts/codesign-release.ts) signs macOS binaries with the Developer ID in the `LOXEL_CERTIFICATE` secret, under the hardened runtime with [`entitlements.mac.plist`](entitlements.mac.plist) (the JIT entitlements Bun's runtime needs) and the identifier `com.bizimind.<packageName>`. Before replacing itself, the running binary checks with `/usr/bin/codesign` that the download satisfies the requirement in [`code-signature.ts`](src/update/code-signature.ts): a Developer ID Application certificate for team `JJ88G244AR` and its own package's identifier. The Team ID is pinned rather than read from the running binary, so the check does not depend on how the running binary was signed.

A binary that fails a check is deleted and the running one is left as it was.

The key pair lives in GitHub: the private key (PKCS#8 PEM) is the `CLI_MANIFEST_SIGNING_KEY` repository secret, and the public key (SPKI DER, base64) is the `CLI_MANIFEST_PUBLIC_KEY` repository variable, which the release builds embed. [`scripts/sign-manifest.ts`](scripts/sign-manifest.ts) signs the manifest and fails unless the two are a pair; each release checks the pair with `--check` before it tags anything. A binary built without `CLI_MANIFEST_PUBLIC_KEY` (a local build, by default) refuses to update. Rotating the pair means replacing both; binaries released before the rotation stop accepting updates and have to be downloaded again by hand.

## Development

```bash
pnpm -C packages/cli-common run typecheck
pnpm -C packages/cli-common run test
```
