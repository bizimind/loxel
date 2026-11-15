/**
 * Reads Claude Code's session transcripts, the JSONL files the CLI keeps under
 * `<config dir>/projects/<project>/<session id>.jsonl`: the conversation of a session a panel
 * resumes or forks (print mode does not replay history on `--resume`), and the list of a
 * project's sessions for the session picker, which includes the ones started in the TUI.
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentEvent, AgentSessionSummary } from "@/api/agent-session-model";
import { isRecord } from "@/lib/is-record";

import { ClaudeStreamNormalizer } from "./claude-stream-normalizer";

/** The CLI's config directory: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: Record<string, string | undefined>): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** The directory of a working directory's sessions: its path with every other character a dash. */
export function projectDir(configDir: string, cwd: string): string {
  return join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

/** The transcript file of a session, found by its id under any project, or null. */
export async function findTranscript(configDir: string, sessionId: string): Promise<string | null> {
  // Matching on the session id alone also finds a session started in another directory.
  const glob = new Bun.Glob(`projects/*/${sessionId}.jsonl`);
  const first = await glob.scan({ cwd: configDir, onlyFiles: true })[Symbol.asyncIterator]().next();
  return first.done ? null : join(configDir, first.value);
}

function parseRecords(content: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record: unknown = JSON.parse(line);
      if (isRecord(record)) records.push(record);
    } catch {
      // A line cut off by a crash, or written by a newer CLI: skipped.
    }
  }
  return records;
}

function isMessage(record: Record<string, unknown>): boolean {
  return (record.type === "user" || record.type === "assistant") && record.isSidechain !== true;
}

/**
 * The main conversation's messages in order: the chain of `parentUuid` links back from `leaf`
 * (the last message when absent). A transcript is a tree: a rewind in the TUI leaves the
 * abandoned branch in the file, and only the chain is what the session continues from.
 */
export function conversationChain(
  records: readonly Record<string, unknown>[],
  leaf?: string,
): Record<string, unknown>[] {
  const byUuid = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    if (typeof record.uuid === "string") byUuid.set(record.uuid, record);
  }
  let current = leaf ? byUuid.get(leaf) : records.findLast(isMessage);
  const chain = new Set<Record<string, unknown>>();
  while (current && !chain.has(current)) {
    chain.add(current);
    current = typeof current.parentUuid === "string" ? byUuid.get(current.parentUuid) : undefined;
  }
  return records.filter((record) => chain.has(record) && isMessage(record));
}

/** The conversation as events, up to and including `leaf` when given. */
export function transcriptEvents(content: string, leaf?: string): AgentEvent[] {
  const normalizer = new ClaudeStreamNormalizer();
  return conversationChain(parseRecords(content), leaf).flatMap((record) =>
    normalizer.normalize(record),
  );
}

/** The text a user record carries, or null for tool results, meta and command bookkeeping. */
function promptText(record: Record<string, unknown>): string | null {
  if (record.type !== "user" || record.isMeta === true) return null;
  const message = isRecord(record.message) ? record.message : null;
  const content = message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((block) => isRecord(block) && block.type === "text")
            .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
            .join("\n")
        : "";
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<") || trimmed.startsWith("[Request interrupted")) {
    return null;
  }
  return trimmed;
}

/** A session's row in the picker, from its transcript. */
export function summarizeSession(
  id: string,
  content: string,
  updatedAt: number,
): AgentSessionSummary {
  const records = parseRecords(content);
  let title: string | null = null;
  let customTitle: string | null = null;
  let branch: string | null = null;
  for (const record of records) {
    if (record.type === "ai-title" && typeof record.aiTitle === "string") title = record.aiTitle;
    if (record.type === "custom-title" && typeof record.customTitle === "string") {
      customTitle = record.customTitle;
    }
    if (isMessage(record) && typeof record.gitBranch === "string") branch = record.gitBranch;
  }
  const prompts = conversationChain(records).flatMap((record) => {
    const text = promptText(record);
    return text ? [text] : [];
  });
  return {
    id,
    title: customTitle ?? title,
    firstPrompt: prompts[0] ?? null,
    messageCount: prompts.length,
    branch,
    updatedAt,
  };
}

const summaryCache = new Map<
  string,
  { mtime: number; size: number; summary: AgentSessionSummary }
>();

/** How many sessions the picker lists, newest first. */
const SESSION_LIMIT = 100;

/** A working directory's sessions with at least one prompt, newest first. */
export async function listSessions(configDir: string, cwd: string): Promise<AgentSessionSummary[]> {
  const dir = projectDir(configDir, cwd);
  const files: { id: string; path: string; mtime: number; size: number }[] = [];
  try {
    for await (const name of new Bun.Glob("*.jsonl").scan({ cwd: dir, onlyFiles: true })) {
      const path = join(dir, name);
      const info = await stat(path);
      files.push({
        id: name.slice(0, -".jsonl".length),
        path,
        mtime: info.mtimeMs,
        size: info.size,
      });
    }
  } catch {
    // No sessions in this directory yet.
    return [];
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const sessions: AgentSessionSummary[] = [];
  for (const file of files.slice(0, SESSION_LIMIT)) {
    const cached = summaryCache.get(file.path);
    let summary = cached?.mtime === file.mtime && cached.size === file.size ? cached.summary : null;
    if (!summary) {
      summary = summarizeSession(file.id, await Bun.file(file.path).text(), file.mtime);
      summaryCache.set(file.path, { mtime: file.mtime, size: file.size, summary });
    }
    if (summary.messageCount > 0) sessions.push(summary);
  }
  return sessions;
}
