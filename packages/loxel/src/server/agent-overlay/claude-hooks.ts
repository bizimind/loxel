/**
 * How Claude Code's hooks reach the overlay. One shell command, the same wherever it is installed,
 * posts each hook's JSON to the server that owns the terminal, identified by the variables Loxel
 * gives every terminal (`LOXEL_PORT`, `LOXEL_TERMINAL_ID`, `LOXEL_AGENT_TOKEN`). Outside a Loxel
 * terminal the token is unset and the command does nothing, so it is safe in the user's own
 * `~/.claude/settings.json` as well as in the settings file a Loxel-launched `claude` gets.
 *
 * The token is an HMAC of the terminal ID with a key kept in the state directory, so it survives
 * server restarts (the terminal outlives the server in its host) without being stored per terminal.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The hook events the overlay listens to. */
export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "SessionEnd",
] as const;

export const HOOK_PATH = "/api/agent-overlay/hook";
export const TERMINAL_HEADER = "x-loxel-terminal";
export const TOKEN_HEADER = "x-loxel-agent-token";

/**
 * Posts the hook input on stdin to the overlay, printing nothing (stdout would be read as a hook
 * decision) and always exiting 0, so a Loxel that is gone or slow never blocks or alters Claude.
 */
export const CLAUDE_HOOK_COMMAND =
  `[ -n "$LOXEL_AGENT_TOKEN" ] && curl -sS -m 3 -o /dev/null -X POST ` +
  `-H 'Content-Type: application/json' -H "X-Loxel-Terminal: $LOXEL_TERMINAL_ID" ` +
  `-H "X-Loxel-Agent-Token: $LOXEL_AGENT_TOKEN" --data-binary @- ` +
  `"http://127.0.0.1:$LOXEL_PORT${HOOK_PATH}" 2>/dev/null; exit 0`;

interface HookGroup {
  matcher?: string;
  hooks: { type: "command"; command: string; timeout: number }[];
}

function loxelHookGroup(): HookGroup {
  return { hooks: [{ type: "command", command: CLAUDE_HOOK_COMMAND, timeout: 5 }] };
}

/** Settings holding only Loxel's hooks, for `claude --settings <file>`. */
export function claudeHookSettings(): { hooks: Record<string, HookGroup[]> } {
  return {
    hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.map((event) => [event, [loxelHookGroup()]])),
  };
}

export class AgentHookAuth {
  private readonly key: Buffer;

  constructor(dir: string) {
    const keyFile = join(dir, "hook.key");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(keyFile)) {
      writeFileSync(keyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
    }
    this.key = Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex");
  }

  /** The `LOXEL_AGENT_TOKEN` of terminal `terminalId`. */
  token(terminalId: string): string {
    return createHmac("sha256", this.key).update(terminalId).digest("hex");
  }

  verify(terminalId: string, token: string): boolean {
    const expected = Buffer.from(this.token(terminalId));
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}

/** Writes the `--settings` file a Loxel-launched `claude` gets, and returns its path. */
export function writeLaunchSettings(dir: string): string {
  const file = join(dir, "claude-hooks.json");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(claudeHookSettings(), null, 2)}\n`, { mode: 0o600 });
  return file;
}

const SAFE_WORD = /^[\w@%+=:,./-]+$/u;
const shellQuote = (word: string) =>
  SAFE_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/** The command line that starts Claude Code with Loxel's hooks. */
export function claudeLaunchCommand(settingsFile: string): string {
  return `claude --settings ${shellQuote(settingsFile)}`;
}
