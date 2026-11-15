/**
 * Claude Code's prompt history, `<config dir>/history.jsonl`: one line per prompt the TUI sent,
 * `{ display, pastedContents, timestamp, project, sessionId }`, where `project` is the session's
 * working directory. The composer walks it with Up and Down, and the panel appends its own
 * prompts in the same shape, so the panel and the TUI share one history. Print mode itself
 * writes none.
 */
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { isRecord } from "@/lib/is-record";

/** How many of a project's prompts the composer gets. */
const HISTORY_LIMIT = 500;

/** A project's prompts from the history file's text, oldest first, repeats in a row merged. */
export function projectPrompts(content: string, project: string): string[] {
  const prompts: string[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry.project !== project || typeof entry.display !== "string")
      continue;
    const text = entry.display.trim();
    if (text && prompts.at(-1) !== text) prompts.push(text);
  }
  return prompts.slice(-HISTORY_LIMIT);
}

export async function readPromptHistory(configDir: string, project: string): Promise<string[]> {
  try {
    return projectPrompts(await Bun.file(join(configDir, "history.jsonl")).text(), project);
  } catch {
    // No history yet, or unreadable: the composer falls back to this session's prompts.
    return [];
  }
}

/**
 * Appends a prompt as the TUI records one. One short line in append mode, so it never interleaves
 * with a line a running TUI writes at the same time.
 */
export async function appendPromptHistory(
  configDir: string,
  entry: { display: string; project: string; sessionId: string },
): Promise<void> {
  const line = JSON.stringify({ ...entry, pastedContents: {}, timestamp: Date.now() });
  await appendFile(join(configDir, "history.jsonl"), `${line}\n`, { flag: "a" });
}
