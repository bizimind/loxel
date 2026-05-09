---
name: logs
description: Query the loxel Axiom dataset to investigate logs. Use the `axiom query` CLI with APL (Axiom Processing Language).
allowed-tools: Bash
---

Interpret the user's request: $ARGUMENTS

## Dataset

All loxel logs are in the `loxel` dataset. Always start queries with `['loxel']`.

## Log Sources

All logs use the same schema via Direct HTTP transport (@axiomhq/js).

Sources: `ccm-daemon`, `ccm-mobile`, `channel-worker`

Key fields:

- `message` - log message
- `level` - log level: `"debug"`, `"info"`, `"warn"`, `"error"`
- `fields.source` - source identifier: `"ccm-daemon"`, `"ccm-mobile"`, `"channel-worker"`
- `fields.*` - structured context (e.g. `fields.sessionId`, `fields.terminalId`, `fields.type`, `fields.channelId`)
- `fields.error.name` - error class name (e.g. `"ReferenceError"`, `"StringError"`)
- `fields.error.message` - error message text
- `fields.error.cause.*` - recursive error cause chain
- `fields.stack` - stack trace
- `fields.componentStack` - React component stack (ccm-mobile)

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
['loxel'] | where ['fields.source'] == 'ccm-daemon'
['loxel'] | where ['fields.source'] == 'channel-worker'
['loxel'] | where level == 'error'
['loxel'] | where message contains 'hook'
['loxel'] | where message startswith 'Daemon'
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

Fields containing dots must be quoted: `['fields.source']`, `['fields.sessionId']`, `['service.name']`

Simple fields without dots need no quoting: `message`, `level`, `severity`, `body`

### Negation

The `!=` operator does not work with string literals in APL. Use `not()` instead:

```apl
| where not(body == 'message')
| where not(['fields.source'] == 'ccm-daemon')
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

### CCM daemon activity

```
axiom query "['loxel'] | where ['fields.source'] == 'ccm-daemon' | project _time, message, ['fields.type'], ['fields.sessionId'] | sort by _time desc | take 20" --start-time="-24h" -f table
```

### Mobile app errors

```
axiom query "['loxel'] | where ['fields.source'] == 'ccm-mobile' | where level == 'error' | project _time, message, ['fields.error.name'], ['fields.error.message'], ['fields.componentStack'] | sort by _time desc | take 20" --start-time="-24h" -f table
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

### Logs for a specific session

```
axiom query "['loxel'] | where ['fields.sessionId'] == 'SESSION_ID_HERE' | project _time, message, ['fields.type'] | sort by _time asc" --start-time="-168h" -f table
```

## Guidelines

- Start with a broad time range (`-24h`) and narrow down as needed
- Use `-f table` for aggregations and overviews, `-f json` when you need full log details
- When investigating an issue, start with error counts, then drill into specific errors
- For ccm-daemon logs, `fields.type` indicates the hook event type (e.g. `PostToolUse`)
- For channel-worker logs, `fields.channelId` identifies the WebSocket channel
- Present results to the user in a clear, summarized format
