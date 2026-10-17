// codeql[js/stack-trace-exposure] — local dev server to local Electron UI; no untrusted network boundary
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** `code` is a machine-readable reason (e.g. `ENOENT`) for clients that must tell cases apart. */
export function error(message: string, status = 400, code?: string): Response {
  const safe = message.split("\n", 1)[0];
  return json(code ? { error: safe, code } : { error: safe }, status);
}
