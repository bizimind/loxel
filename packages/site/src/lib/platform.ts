export type Platform = "mac-arm" | "mac-intel" | "other";

interface ArchitectureHints {
  getHighEntropyValues(hints: string[]): Promise<{ architecture?: string }>;
}

// User-Agent Client Hints are Chromium-only and not in TypeScript's DOM types.
function userAgentData(): ArchitectureHints | undefined {
  if (!("userAgentData" in navigator)) return undefined;
  const data: unknown = navigator.userAgentData;
  if (typeof data !== "object" || data === null || !("getHighEntropyValues" in data)) {
    return undefined;
  }
  return typeof data.getHighEntropyValues === "function" ? (data as ArchitectureHints) : undefined;
}

/** The visitor's platform, for picking the download to offer. */
export async function detectPlatform(): Promise<Platform> {
  const ua = navigator.userAgent;
  if (!ua.includes("Mac") && !ua.includes("macOS")) return "other";
  // iPhones say "like Mac OS X", and iPadOS Safari reports itself as a Mac but has touch.
  if (/iPhone|iPad|iPod/.test(ua) || navigator.maxTouchPoints > 1) return "other";
  try {
    const hints = await userAgentData()?.getHighEntropyValues(["architecture"]);
    // Safari and Firefox don't expose the architecture (their user agent says "Intel" on every Mac),
    // so anything not reported as x86 is assumed to be Apple Silicon.
    return hints?.architecture === "x86" ? "mac-intel" : "mac-arm";
  } catch {
    return "mac-arm";
  }
}
