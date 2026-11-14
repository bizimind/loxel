/**
 * Reads a Claude Code session's transcript, the JSONL file the CLI keeps under
 * `<config dir>/projects/<project>/<session id>.jsonl`, so a resumed panel shows the conversation
 * it had before a server restart. Print mode does not replay history on `--resume`.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentEvent } from "@/api/agent-session-model";

import { ClaudeStreamNormalizer } from "./claude-stream-normalizer";

/** The CLI's config directory: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: Record<string, string | undefined>): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** The transcript file of a session, found by its id under any project, or null. */
export async function findTranscript(configDir: string, sessionId: string): Promise<string | null> {
  // The project directory is the cwd with separators replaced; matching on the session id avoids
  // depending on that encoding.
  const glob = new Bun.Glob(`projects/*/${sessionId}.jsonl`);
  const first = await glob.scan({ cwd: configDir, onlyFiles: true })[Symbol.asyncIterator]().next();
  return first.done ? null : join(configDir, first.value);
}

/** The transcript's conversation as events. Lines that do not parse are skipped. */
export function transcriptEvents(content: string): AgentEvent[] {
  const normalizer = new ClaudeStreamNormalizer();
  const events: AgentEvent[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    // Transcript records carry user and assistant messages in the stream's shape; their system
    // records are the CLI's own bookkeeping, not conversation.
    const isMessage =
      typeof record === "object" &&
      record !== null &&
      "type" in record &&
      (record.type === "user" || record.type === "assistant");
    if (isMessage) events.push(...normalizer.normalize(record));
  }
  return events;
}
