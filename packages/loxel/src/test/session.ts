import { bearer, readSessionToken } from "@/app-session";

/**
 * The header a test sends to a server it started without the app for `stateDir`: the session
 * secret the server wrote to its token file before it began listening.
 */
export function sessionAuthorization(stateDir: string): { Authorization: string } {
  const secret = readSessionToken(stateDir);
  if (!secret) throw new Error(`The server wrote no session token in ${stateDir}`);
  return { Authorization: bearer(secret) };
}
