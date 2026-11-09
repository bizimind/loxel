#!/usr/bin/env bash
# PreToolUse hook for the triage agent: the only command it may run is `sbx '<command>'`, which
# runs it as the sandbox user. Anything else (including the read-only commands Claude Code would
# allow on its own) would run as the runner user, next to the Claude token. The agent's answer
# comes through the StructuredOutput tool, which runs nothing.
set -euo pipefail
# Exit code 2 blocks the call; any other failure would let Claude Code carry on without the hook.
trap 'exit 2' ERR

input=$(cat)
tool=$(jq -r '.tool_name' <<<"$input")
command=$(jq -r '.tool_input.command // empty' <<<"$input")

if [[ "$tool" == "StructuredOutput" ]]; then
  exit 0
fi
if [[ "$tool" == "Bash" && "$command" =~ ^sbx\ \'[^\']*\'$ ]]; then
  exit 0
fi

jq -n '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "Only `sbx '\''<command>'\''` may run, with the whole command as one single-quoted argument. Put any pipes, && or cd inside the quotes, and use double quotes, not single quotes, within it."
  }
}'
