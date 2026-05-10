# cc-tool-guard

A PermissionRequest hook for Claude Code that auto-approves safe Bash commands and Read operations using pattern matching, with Haiku fallback for uncertain cases.

## Features

- Auto-approves safe commands based on pattern matching
- Evaluates file read operations against project boundaries
- Adds approved patterns to settings.json for future auto-approval
- Logs all evaluations for auditing
- Falls back to user prompt for uncertain commands

## Installation

```bash
# Build
bun run build

# Install to ~/.local/bin
cp dist/cc-tool-guard ~/.local/bin/
codesign -s - ~/.local/bin/cc-tool-guard
```

## Setup

Add cc-tool-guard as a PermissionRequest hook in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PermissionRequest": [
      { "matcher": "Bash", "hooks": ["cc-tool-guard"] },
      { "matcher": "Read", "hooks": ["cc-tool-guard"] }
    ]
  }
}
```

## Configuration

### Update Mode

Control where approved patterns are persisted using the `--update` flag:

```json
{
  "hooks": {
    "PermissionRequest": [
      { "matcher": "Bash", "hooks": ["cc-tool-guard --update local"] },
      { "matcher": "Read", "hooks": ["cc-tool-guard --update local"] }
    ]
  }
}
```

| Mode             | Target File                   | Description                         |
| ---------------- | ----------------------------- | ----------------------------------- |
| `none` (default) | -                             | Don't persist patterns              |
| `user`           | `~/.claude/settings.json`     | Global user settings                |
| `project`        | `.claude/settings.json`       | Project settings (committed)        |
| `local`          | `.claude/settings.local.json` | Local project settings (gitignored) |

The default mode is `none`, which means patterns are not persisted. Use `--update local` for typical workflows where you want patterns to persist but not be committed to version control.

## How It Works

1. **Receives** JSON input from Claude Code via stdin with tool name and input
2. **Evaluates** the command/path against safe patterns and project context
3. **Approves** safe operations by outputting `{"decision": {"behavior": "allow"}}`
4. **Defers** uncertain operations by exiting without output (user prompt appears)

### Bash Command Evaluation

Commands are evaluated against patterns in `src/evaluator/patterns.ts`:

- **Safe**: Read-only commands (`ls`, `cat`, `git status`), build tools (`npm test`)
- **Unsafe**: Destructive commands (`rm -rf`), elevated privileges (`sudo`)
- **Uncertain**: Commands that need context or user judgment

### Read File Evaluation

File paths are checked against:

- Project root boundaries (no escaping via `../`)
- Allowed directories within the project
- Blocked paths (secrets, credentials)

## Logs

Evaluation logs are written to:

```
~/.local/state/loxel/cc-tool-guard/calls-log.jsonl
```

Each entry includes timestamp, command, evaluation path, classification, and reason.

## Development

```bash
# Run tests
bun test

# Type check
bun run typecheck
```

## License

[FSL-1.1-ALv2](../../LICENSE) — source available for non-competing use; converts to Apache 2.0 on May 10, 2028.
