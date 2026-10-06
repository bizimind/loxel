# cc-tool-guard

A PermissionRequest hook for Claude Code that auto-approves safe Bash commands and Read operations using pattern matching, with Haiku fallback for uncertain cases.

## Features

- Auto-approves safe commands based on pattern matching
- Prompts before reading sensitive files (secrets, keys, credentials)
- Optionally persists approved patterns to Claude Code settings for future auto-approval
- Logs all evaluations for auditing
- Falls back to user prompt for uncertain commands

## Installation

```bash
pnpm run build

# Install to ~/.local/bin (ad-hoc signing is required on macOS)
cp dist/cc-tool-guard ~/.local/bin/
codesign -s - ~/.local/bin/cc-tool-guard
```

Uncertain Bash commands are evaluated with `claude -p --model haiku`, so the `claude` CLI must be on PATH.

## Setup

Add cc-tool-guard as a PermissionRequest hook in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PermissionRequest": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "cc-tool-guard" }] },
      { "matcher": "Read", "hooks": [{ "type": "command", "command": "cc-tool-guard" }] }
    ]
  }
}
```

## Configuration

### Update Mode

Control where approved patterns are persisted using the `--update` flag, e.g. `"command": "cc-tool-guard --update local"`:

| Mode             | Target File                   | Description                         |
| ---------------- | ----------------------------- | ----------------------------------- |
| `none` (default) | -                             | Don't persist patterns              |
| `user`           | `~/.claude/settings.json`     | Global user settings                |
| `project`        | `.claude/settings.json`       | Project settings (committed)        |
| `local`          | `.claude/settings.local.json` | Local project settings (gitignored) |

Approved patterns are appended to `permissions.allow` as `Bash(<pattern>)`. Use `--update local` for typical workflows where you want patterns to persist but not be committed to version control. Only approvals that come with a suggested pattern are persisted (a known safe single command whose rule defines a pattern, or Haiku's suggestion); chained commands matched by known patterns, `git push`, and Read approvals are allowed per call only.

## How It Works

1. **Receives** the PermissionRequest JSON from Claude Code via stdin (`tool_name`, `tool_input`, `cwd`)
2. **Evaluates** the command or path against known patterns and the project context (git root, current branch)
3. **Approves** safe operations by printing `{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}`
4. **Defers** uncertain operations by exiting without output, so the normal permission prompt appears

cc-tool-guard never denies; anything it is not sure about falls through to the user.

### Bash Command Evaluation

Commands are evaluated against patterns in `src/evaluator/patterns.ts`:

- **Dangerous** patterns (e.g. `sudo`, global package installs) and pushes to `main`/`master` are deferred to the user
- **Safe** patterns (read-only commands, common build/test tools, pushes to feature branches) are approved
- Write commands targeting paths outside the project (home directory, absolute paths other than `/tmp`) are deferred
- Chained commands are approved only if every part is safe
- Unknown commands and complex shell constructs (command substitution, heredocs, `eval`, `xargs`, multi-line) are classified by Haiku; if Haiku fails after retries, the command is deferred

### Read File Evaluation

Reads are approved unless the path matches a sensitive-file pattern in `src/evaluator/read-patterns.ts` (e.g. `.env.local`, keys and certificates, `~/.ssh`, cloud credentials, shell history, Terraform state), in which case the user is prompted.

## Logs

Evaluation logs are written to:

```
~/.local/state/loxel/cc-tool-guard/calls-log.jsonl
```

Each entry includes timestamp, duration, tool input, project context, evaluation path (`pattern-safe`, `pattern-unsafe`, `haiku`, `haiku-failed`), classification, reason, and the output decision.

## Development

```bash
pnpm run test
pnpm run typecheck
```

## License

[FSL-1.1-ALv2](../../LICENSE) — source available for non-competing use; converts to Apache 2.0 after 2 years.
