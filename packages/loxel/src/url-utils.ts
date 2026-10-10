/**
 * Check whether a string is a valid http: or https: URL.
 *
 * Also serves as the guard for opening URLs externally (`shell.openExternal`) — it rejects
 * `file://`, custom protocols, and anything that fails to parse.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
