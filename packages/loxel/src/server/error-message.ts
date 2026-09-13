/**
 * Build a user-facing message from a thrown error, preferring the underlying
 * command's own stderr. `Bun.$` ShellErrors carry only the exit code in
 * `message` ("Failed with exit code 255") with the real diagnostic on
 * `stderr`; wrapped errors carry it further down the cause chain.
 */
export function describeError(err: unknown, fallback: string): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current.message) parts.push(current.message.trim());
    const stderr = readStderr(current);
    if (stderr) parts.push(stderr);
    current = current.cause;
  }
  const message = [...new Set(parts.filter(Boolean))].join(": ").trim();
  return message || fallback;
}

/** Read a trimmed `stderr` field off an error, if it has one (Bun.$ ShellError). */
function readStderr(err: Error): string | null {
  const raw: unknown = (err as unknown as { stderr?: unknown }).stderr;
  const text =
    typeof raw === "string"
      ? raw
      : raw instanceof Uint8Array
        ? new TextDecoder().decode(raw)
        : null;
  return text?.trim() ? text.trim() : null;
}
