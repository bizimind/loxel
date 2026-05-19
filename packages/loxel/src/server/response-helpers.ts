// codeql[js/stack-trace-exposure] — local dev server to local Electron UI; no untrusted network boundary
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function error(message: string, status = 400): Response {
  const safe = message.split("\n", 1)[0];
  return json({ error: safe }, status);
}
