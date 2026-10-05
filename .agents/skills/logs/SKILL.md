---
name: logs
description: Query the loxel Axiom dataset to investigate logs. Use the `axiom query` CLI with APL (Axiom Processing Language).
allowed-tools: Bash
---

Interpret the user's request: $ARGUMENTS

## Dataset

All loxel logs are in the `loxel` dataset. Always start queries with `['loxel']`.

## Log Sources

All logs use the same schema, written by `@bizimind/logger` (`packages/logger`) over Axiom's HTTP transport. Valid source IDs are the `LogSource` union in `packages/logger/src/types.ts`.

Current emitters:

- `channel-worker` — Cloudflare Worker; dataset set in `packages/channel-worker/wrangler.toml`
- `coding-agent` — CLI runtime, only when `AXIOM_TOKEN` and `AXIOM_DATASET` are set; adds `fields.component` = `"cli-runtime"`

The loxel IDE server does not send logs to Axiom (it writes local NDJSON files, see `packages/loxel/README.md`). Older data may contain sources from removed packages (e.g. `ccm-daemon`, `ccm-mobile`).

Key fields:

- `message` - log message
- `level` - log level: `"debug"`, `"info"`, `"warn"`, `"error"`
- `fields.source` - source identifier (e.g. `"channel-worker"`, `"coding-agent"`)
- `fields.*` - structured context passed at the call site (e.g. `fields.channelId`, `fields.component`)
- `fields.error.name` - error class name (e.g. `"TypeError"`)
- `fields.error.message` - error message text
- `fields.error.cause.*` - recursive error cause chain

## CLI Usage

```
axiom query "<APL_QUERY>" --start-time="-<N>h" [-f table|json]
```

- `--start-time` accepts relative hours: `-1h`, `-24h`, `-168h` (7 days). Does NOT accept `-7d` format.
- `-f table` for aggregations and human-readable output (default)
- `-f json` for raw log entries (one JSON object per line)
- For json output, pipe through a filter to remove null fields for readability:
  ```
  axiom query "..." -f json | python3 -c "
  import json, sys
  for line in sys.stdin:
      line = line.strip()
      if not line: continue
      try:
          obj = json.loads(line)
          filtered = {k: v for k, v in obj.items() if v is not None}
          print(json.dumps(filtered, indent=2))
          print('---')
      except: pass
  "
  ```

## APL Quick Reference

### Filtering

```apl
['loxel'] | where ['fields.source'] == 'channel-worker'
['loxel'] | where ['fields.source'] == 'coding-agent'
['loxel'] | where level == 'error'
['loxel'] | where message contains 'hook'
['loxel'] | where message startswith 'Channel'
['loxel'] | where isnotnull(['fields.error.name'])
```

### Selecting fields

```apl
| project _time, message, level, ['fields.source']
| project _time, message, ['fields.error.name'], ['fields.error.message']
```

### Sorting and limiting

```apl
| sort by _time desc
| take 20
```

### Aggregations (use `-f table`)

```apl
| summarize count() by ['fields.source']
| summarize count() by level
| summarize count() by message | sort by count_ desc | take 15
| summarize count() by bin_auto(_time)
| summarize count() by bin_auto(_time), ['fields.source']
```

### Field name escaping

Fields containing dots must be quoted: `['fields.source']`, `['fields.channelId']`, `['service.name']`

Simple fields without dots need no quoting: `message`, `level`, `severity`, `body`

### Negation

The `!=` operator does not work with string literals in APL. Use `not()` instead:

```apl
| where not(body == 'message')
| where not(['fields.source'] == 'channel-worker')
```

### Checking for non-empty values

Use `isnotnull()`:

```apl
| where isnotnull(['fields.error.name'])
```

## Common Query Patterns

### Recent errors (all sources)

```
axiom query "['loxel'] | where level == 'error' | project _time, message, ['fields.error.name'], ['fields.error.message'], ['fields.source'] | sort by _time desc | take 20" --start-time="-24h" -f table
```

### Coding agent errors

```
axiom query "['loxel'] | where ['fields.source'] == 'coding-agent' | where level == 'error' | project _time, message, ['fields.error.name'], ['fields.error.message'] | sort by _time desc | take 20" --start-time="-24h" -f table
```

### Error rate over time

```
axiom query "['loxel'] | where level == 'error' | summarize count() by bin_auto(_time)" --start-time="-168h" -f table
```

### Log volume by source

```
axiom query "['loxel'] | summarize count() by ['fields.source']" --start-time="-24h" -f table
```

### Top log messages

```
axiom query "['loxel'] | summarize count() by message | sort by count_ desc | take 20" --start-time="-24h" -f table
```

### Channel worker activity

```
axiom query "['loxel'] | where ['fields.source'] == 'channel-worker' | project _time, message, level, ['fields.channelId'] | sort by _time desc | take 20" --start-time="-24h" -f table
```

### Logs for a specific channel

```
axiom query "['loxel'] | where ['fields.channelId'] == 'CHANNEL_ID_HERE' | project _time, message, level | sort by _time asc" --start-time="-168h" -f table
```

## Guidelines

- Start with a broad time range (`-24h`) and narrow down as needed
- Use `-f table` for aggregations and overviews, `-f json` when you need full log details
- When investigating an issue, start with error counts, then drill into specific errors
- For channel-worker logs, `fields.channelId` identifies the WebSocket channel
- Present results to the user in a clear, summarized format
