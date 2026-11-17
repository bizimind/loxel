/**
 * The app's session secret: what proves that a request to the server's loopback TCP port comes from
 * the app. The desktop app generates it once per run and hands it to the server it starts over its
 * channel (parent-channel-protocol.ts); main adds it as a Bearer header to its own requests and to
 * its windows'. A server started without the app (dev, tests) makes its own and writes it to its
 * token file for the tools that drive it (session-client.ts). See
 * docs/ARCHITECTURE.md#request-admission.
 *
 * Shared by the server, Electron main, the Vite dev proxy and session-client.ts.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

/** 32 random bytes, base64url: safe in a header and a line of the app's channel. */
export const SessionSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export function newSessionSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** The `Authorization` header value that carries `secret`. */
export function bearer(secret: string): string {
  return `Bearer ${secret}`;
}

/**
 * Where a server started without the app keeps its secret: `<stateDir>/run/session-token`, 0600 in
 * the private run directory.
 */
export function sessionTokenPath(stateDir: string): string {
  return join(stateDir, "run", "session-token");
}

/** The secret in the token file of the server for `stateDir`, or null when there is none. */
export function readSessionToken(stateDir: string): string | null {
  let text: string;
  try {
    text = readFileSync(sessionTokenPath(stateDir), "utf8");
  } catch {
    return null;
  }
  const parsed = SessionSecretSchema.safeParse(text.trim());
  return parsed.success ? parsed.data : null;
}
