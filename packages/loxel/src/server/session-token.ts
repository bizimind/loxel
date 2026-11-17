/**
 * The token file of a server started without the desktop app (`pnpm run dev:server`, tests, e2e)
 * or of a demo: `<stateDir>/run/session-token`, holding the server's session secret
 * (app-session.ts) for the tools that drive it, such as the Vite dev proxy and Playwright. Only the
 * user's own account can read it: 0600, in the private run directory. A server the installed app
 * started writes none; the secret then lives only in the app and the server.
 */
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { readSessionToken, sessionTokenPath } from "@/app-session";
import { ensurePrivateDir } from "@/socket-paths";

/**
 * Write `secret` to the token file, replacing whatever is there in one step, so a reader never sees
 * half of it.
 */
export function writeSessionToken(stateDir: string, secret: string): void {
  const path = sessionTokenPath(stateDir);
  ensurePrivateDir(dirname(path));
  const temp = `${path}.${process.pid}`;
  writeFileSync(temp, `${secret}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** Remove the token file unless a newer server for the same state directory has replaced it. */
export function removeSessionToken(stateDir: string, secret: string): void {
  if (readSessionToken(stateDir) === secret) unlinkSync(sessionTokenPath(stateDir));
}
