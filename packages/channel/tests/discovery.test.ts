import { describe, test, expect } from "bun:test";

import { generateChannelId, parseChannelUrl, createShareableUrl } from "../src/discovery.ts";

describe("generateChannelId", () => {
  test("generates unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateChannelId());
    }
    expect(ids.size).toBe(100);
  });

  test("generates URL-safe characters", () => {
    for (let i = 0; i < 50; i++) {
      const id = generateChannelId();
      // Base58 alphabet only
      expect(id).toMatch(/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/);
    }
  });

  test("respects byte length parameter", () => {
    const short = generateChannelId(4);
    const long = generateChannelId(16);

    // Shorter byte length produces shorter IDs
    expect(short.length).toBeLessThan(long.length);
  });

  test("default length produces reasonable IDs", () => {
    const id = generateChannelId();
    // 8 bytes -> roughly 11 base58 characters
    expect(id.length).toBeGreaterThanOrEqual(8);
    expect(id.length).toBeLessThanOrEqual(14);
  });
});

describe("parseChannelUrl", () => {
  test("parses WebSocket URLs with /channel/ path", () => {
    const result = parseChannelUrl("wss://example.com/channel/abc123");
    expect(result).toEqual({ host: "example.com", channelId: "abc123" });
  });

  test("parses HTTPS URLs with /channel/ path", () => {
    const result = parseChannelUrl("https://example.com/channel/room-456");
    expect(result).toEqual({ host: "example.com", channelId: "room-456" });
  });

  test("parses URLs with /join/ path", () => {
    const result = parseChannelUrl("https://myapp.com/join/7kXm9Pq2");
    expect(result).toEqual({ host: "myapp.com", channelId: "7kXm9Pq2" });
  });

  test("parses custom scheme", () => {
    const result = parseChannelUrl("channel:abc123");
    expect(result).toEqual({ channelId: "abc123" });
  });

  test("parses plain channel ID", () => {
    const result = parseChannelUrl("abc123");
    expect(result).toEqual({ channelId: "abc123" });
  });

  test("handles URL-encoded channel IDs", () => {
    const result = parseChannelUrl("https://example.com/channel/room%20name");
    expect(result).toEqual({ host: "example.com", channelId: "room name" });
  });

  test("handles trailing slashes", () => {
    const result = parseChannelUrl("https://example.com/channel/abc123/");
    expect(result).toEqual({ host: "example.com", channelId: "abc123" });
  });

  test("handles ports in URL", () => {
    const result = parseChannelUrl("wss://localhost:8080/channel/test");
    expect(result).toEqual({ host: "localhost:8080", channelId: "test" });
  });

  test("returns null for empty input", () => {
    expect(parseChannelUrl("")).toBeNull();
    expect(parseChannelUrl("   ")).toBeNull();
  });

  test("returns null for invalid paths", () => {
    expect(parseChannelUrl("https://example.com/invalid/abc")).toBeNull();
    expect(parseChannelUrl("https://example.com/channel")).toBeNull();
    expect(parseChannelUrl("https://example.com/channel/")).toBeNull();
  });

  test("returns null for too long channel IDs", () => {
    const longId = "a".repeat(129);
    expect(parseChannelUrl(`channel:${longId}`)).toBeNull();
    expect(parseChannelUrl(longId)).toBeNull();
  });

  test("handles channel IDs with special characters", () => {
    const result = parseChannelUrl("game-lobby-123");
    expect(result).toEqual({ channelId: "game-lobby-123" });
  });

  test("trims whitespace", () => {
    const result = parseChannelUrl("  abc123  ");
    expect(result).toEqual({ channelId: "abc123" });
  });
});

describe("createShareableUrl", () => {
  test("creates URL with default path", () => {
    const url = createShareableUrl("https://myapp.com", "abc123");
    expect(url).toBe("https://myapp.com/join/abc123");
  });

  test("creates URL with custom path", () => {
    const url = createShareableUrl("https://myapp.com", "abc123", "channel");
    expect(url).toBe("https://myapp.com/channel/abc123");
  });

  test("handles base URL with trailing slash", () => {
    const url = createShareableUrl("https://myapp.com/", "abc123");
    expect(url).toBe("https://myapp.com/join/abc123");
  });

  test("encodes special characters in channel ID", () => {
    const url = createShareableUrl("https://myapp.com", "room name");
    expect(url).toBe("https://myapp.com/join/room%20name");
  });

  test("works with localhost", () => {
    const url = createShareableUrl("http://localhost:3000", "test");
    expect(url).toBe("http://localhost:3000/join/test");
  });
});
