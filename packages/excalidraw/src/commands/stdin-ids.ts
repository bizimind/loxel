/**
 * Flexible stdin ID parser for piping element IDs between commands.
 *
 * Supports all common jq output shapes:
 * - Newline-separated raw IDs:      abc123\ndef456
 * - Newline-separated quoted IDs:   "abc123"\n"def456"
 * - JSON array of strings:          ["abc123","def456"]
 * - JSON array of objects:          [{"id":"abc123",...}]
 * - Newline-separated JSON objects: {"id":"abc123",...}\n{"id":"def456",...}
 * - Comma-separated:                abc123,def456
 */

/** Extract an ID from a parsed JSON value (string or object with .id) */
function extractId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as Record<string, unknown>).id;
    if (typeof id === "string") return id;
  }
  return null;
}

/** Try to parse a string as JSON and extract IDs. Returns null if not valid JSON. */
function tryParseJson(text: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      const ids: string[] = [];
      for (const item of parsed) {
        const id = extractId(item);
        if (id) ids.push(id);
      }
      return ids.length > 0 ? ids : null;
    }
    const id = extractId(parsed);
    return id ? [id] : null;
  } catch {
    return null;
  }
}

/** Parse IDs from a text string in any supported format */
export function parseIds(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Try parsing the whole input as JSON first
  const jsonIds = tryParseJson(trimmed);
  if (jsonIds) return jsonIds;

  // Try as concatenated JSON objects (jq pretty-print output: {...}\n{...})
  // Wrap in array brackets and insert commas between adjacent objects
  if (trimmed.startsWith("{")) {
    const wrapped = "[" + trimmed.replace(/\}\s*\{/g, "},{") + "]";
    const wrappedIds = tryParseJson(wrapped);
    if (wrappedIds) return wrappedIds;
  }

  // Split by newlines first, then try each line as JSON or plain text.
  // Comma splitting is only used for lines that aren't JSON objects.
  const ids: string[] = [];
  const lines = trimmed.split("\n");
  for (const raw of lines) {
    const token = raw.trim();
    if (!token) continue;

    // Try parsing as JSON (handles quoted strings and objects)
    try {
      const parsed: unknown = JSON.parse(token);
      const id = extractId(parsed);
      if (id) {
        ids.push(id);
        continue;
      }
    } catch {
      // Not JSON — fall through to plain text handling
    }

    // Plain text: split by commas (for "id1,id2" format), strip quotes
    const parts = token.split(",");
    for (const part of parts) {
      const stripped = part.trim().replace(/^["']|["']$/g, "");
      if (stripped) ids.push(stripped);
    }
  }

  return ids;
}

/**
 * Read element IDs from stdin when piped (non-TTY).
 * Returns null if stdin is a TTY (interactive).
 */
async function readIdsFromStdin(): Promise<string[] | null> {
  if (process.stdin.isTTY) return null;
  const text = await Bun.stdin.text();
  const ids = parseIds(text);
  return ids.length > 0 ? ids : null;
}

/**
 * Resolve IDs from positional args or stdin.
 * If positional IDs are provided, use them.
 * If no positional IDs and stdin is piped, read and parse from stdin.
 * Throws if no IDs available from either source.
 */
export async function resolveIds(positionalIds: string[] | undefined): Promise<string[]> {
  if (positionalIds && positionalIds.length > 0) return positionalIds;
  const stdinIds = await readIdsFromStdin();
  if (stdinIds && stdinIds.length > 0) return stdinIds;
  throw new Error("No element IDs provided. Pass IDs as arguments or pipe them via stdin.");
}

/**
 * Try to read IDs from stdin if available (non-throwing).
 * Returns undefined if stdin is a TTY or empty.
 */
export async function tryReadStdinIds(): Promise<string[] | undefined> {
  const ids = await readIdsFromStdin();
  return ids ?? undefined;
}

/** Read all text from stdin. Used by import commands that receive raw content. */
export async function readStdinText(): Promise<string> {
  return Bun.stdin.text();
}
