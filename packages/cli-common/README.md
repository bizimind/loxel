# cli-common

Shared building blocks for the monorepo's Bun CLIs: command output handling, human-readable formatters, Axiom logging setup, and the self-update system for compiled binaries. Used by [wt](../wt), [excalidraw](../excalidraw), [coding-agent](../coding-agent), and [code-analysis](../code-analysis).

Workspace-only; add `"@bizimind/cli-common": "workspace:*"` and import from `@bizimind/cli-common`. Everything public is exported from [`src/index.ts`](src/index.ts), including a re-export of Commander's `Command` so all CLIs share one Commander version.

## Command results and output modes

Commands return a `CommandResult<T>` (data, a human formatter, and an exit code) and run through `runAction()` / `runActionSync()`, which pick `json`, `human`, or `quiet` mode from the `--json` / `--quiet` flags, print the result, and set `process.exitCode`. Progress output goes through the `OutputContext` passed to the action, so JSON stdout stays clean (progress is sent to stderr in JSON mode and suppressed in quiet mode).

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

`createUpdateSystem({ packageName, getCurrentVersion, ... })` checks `https://loxel.bizimind.io/<packageName>/manifest.json`, downloads the binary for the current platform, verifies its SHA-256, and replaces the running executable. Update checks can be cached (default TTL 1 hour, under `~/.local/state/loxel/<packageName>`). Built on top of it:

- `createVersionCommand(config)` / `createUpdateCommand(config)` — ready-made `version` and `update` subcommands
- `maybeAutoUpdate(config, argv)` — update before running a command and re-execute it with the new binary

## Logging

`createCliLogger({ source, ... }, context)` returns an [`@bizimind/logger`](../logger) instance that ships to Axiom when an `AXIOM_TOKEN` is available (environment variable or build-time default) and is a no-op otherwise; `logCliError` records failures with CLI context.

## Development

```bash
pnpm -C packages/cli-common run typecheck
```
