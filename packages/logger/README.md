# logger

Structured logging wrapper around [Axiom](https://axiom.co) (`@axiomhq/logging`). Every entry is tagged with its source, errors are serialized with their full cause chain, and context is sanitized before it leaves the process. Used by [cli-common](../cli-common), [coding-agent](../coding-agent), and [channel-worker](../channel-worker).

Workspace-only; add `"@bizimind/logger": "workspace:*"`. Public API is in [`src/index.ts`](src/index.ts); config and source types are in `src/types.ts`.

## Usage

```typescript
import { createLogger } from "@bizimind/logger";

const logger = createLogger({
  source: "wt",
  mode: "http", // or "console"
  axiomToken: process.env.AXIOM_TOKEN,
  axiomDataset: process.env.AXIOM_DATASET,
  level: "info", // default "debug"
});

logger.info("Started", { port: 7432 });
logger.with({ requestId }).error("Request failed", { error });
await logger.flush(); // before exit
```

## API at a glance

- `createLogger(config)` — `http` mode sends to Axiom and requires `axiomToken` and `axiomDataset`; `console` mode writes to the console (pretty-printed outside production).
- `createNoopLogger()` — discards everything; for code paths that need an `AppLogger` but no output.
- `AppLogger` — `debug` / `info` / `warn` / `error(message, context?)`, `with(context)` for child loggers, and `flush()`.
- `serializeError(error)` — converts an error into `{ name, message, props?, cause? }`, following `cause` up to 10 levels. Applied automatically to the `error` context field.
- `sanitizeContext` / `sanitizeValue` — redact values whose keys look sensitive (`token`, `secret`, `password`, `auth`, `stack`, ...) and truncate strings over 10 KB. Applied automatically to every entry.
- `LogSource` — the allowed `source` names; add a new one in `src/types.ts` when a new package starts logging.

## Development

```bash
pnpm -C packages/logger run test
pnpm -C packages/logger run typecheck
```
