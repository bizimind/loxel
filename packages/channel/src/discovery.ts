/**
 * Base58 alphabet (excludes confusing characters: 0, O, I, l)
 */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Encode bytes to Base58 string.
 */
function base58Encode(bytes: Uint8Array): string {
  // Convert bytes to a big integer
  let num = 0n;
  for (const byte of bytes) {
    num = num * 256n + BigInt(byte);
  }

  // Convert to base58
  let result = "";
  while (num > 0n) {
    const remainder = Number(num % 58n);
    result = BASE58_ALPHABET[remainder] + result;
    num = num / 58n;
  }

  // Add leading '1's for leading zero bytes
  for (const byte of bytes) {
    if (byte === 0) {
      result = "1" + result;
    } else {
      break;
    }
  }

  return result || "1";
}

/**
 * Generate a random channel ID suitable for sharing.
 * Uses Base58 encoding for URL-safe, human-readable IDs.
 *
 * @param byteLength Number of random bytes to use (default: 8, produces ~11 char ID)
 * @returns A random Base58-encoded channel ID
 *
 * @example
 * const channelId = generateChannelId();  // e.g., "7kXm9Pq2aB"
 */
export function generateChannelId(byteLength = 8): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base58Encode(bytes);
}

/**
 * Result of parsing a channel URL.
 */
export interface ParsedChannelUrl {
  /** The extracted channel ID */
  channelId: string;
  /** The host from the URL, if available */
  host?: string;
}

/**
 * Parse a channel URL to extract the channel ID.
 *
 * Supports formats:
 * - `wss://host/channel/CHANNEL_ID`
 * - `https://host/channel/CHANNEL_ID`
 * - `https://host/join/CHANNEL_ID`
 * - `channel:CHANNEL_ID` (custom scheme)
 * - `CHANNEL_ID` (plain channel ID)
 *
 * @param url The URL or channel ID to parse
 * @returns Parsed result or null if invalid
 *
 * @example
 * parseChannelUrl("wss://example.com/channel/abc123")
 * // { host: "example.com", channelId: "abc123" }
 *
 * parseChannelUrl("https://myapp.com/join/7kXm9Pq2")
 * // { host: "myapp.com", channelId: "7kXm9Pq2" }
 *
 * parseChannelUrl("channel:abc123")
 * // { channelId: "abc123" }
 *
 * parseChannelUrl("abc123")
 * // { channelId: "abc123" }
 */
export function parseChannelUrl(url: string): ParsedChannelUrl | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // Handle custom scheme: channel:CHANNEL_ID
  if (trimmed.startsWith("channel:")) {
    const channelId = trimmed.slice(8);
    if (channelId.length > 0 && channelId.length <= 128) {
      return { channelId };
    }
    return null;
  }

  // Try to parse as URL
  try {
    const parsed = new URL(trimmed);

    // Match /channel/CHANNEL_ID or /join/CHANNEL_ID
    const match = parsed.pathname.match(/^\/(?:channel|join)\/([^/]+)\/?$/);
    if (match?.[1]) {
      const channelId = decodeURIComponent(match[1]);
      if (channelId.length > 0 && channelId.length <= 128) {
        return { host: parsed.host, channelId };
      }
    }

    return null;
  } catch {
    // Not a valid URL, treat as plain channel ID
    if (trimmed.length > 0 && trimmed.length <= 128 && !trimmed.includes("/")) {
      return { channelId: trimmed };
    }
    return null;
  }
}

/**
 * Create a shareable URL for a channel.
 *
 * @param baseUrl The base URL of your application (e.g., "https://myapp.com")
 * @param channelId The channel ID to include
 * @param path The path prefix (default: "join")
 * @returns A shareable URL
 *
 * @example
 * createShareableUrl("https://myapp.com", "7kXm9Pq2")
 * // "https://myapp.com/join/7kXm9Pq2"
 *
 * createShareableUrl("https://myapp.com", "abc", "channel")
 * // "https://myapp.com/channel/abc"
 */
export function createShareableUrl(baseUrl: string, channelId: string, path = "join"): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/${path}/${encodeURIComponent(channelId)}`;
}
