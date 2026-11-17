import { describe, expect, test } from "bun:test";

import { isSameOrigin, isStorableFavicon } from "./url-utils";

describe("isStorableFavicon", () => {
  test("keeps web URLs and small inline images", () => {
    expect(isStorableFavicon("https://example.com/favicon.ico")).toBe(true);
    expect(isStorableFavicon("http://localhost:5173/icon.svg")).toBe(true);
    expect(isStorableFavicon("data:image/png;base64,AA")).toBe(true);
  });

  test("drops other schemes, inline non-images, and oversized favicons", () => {
    expect(isStorableFavicon("javascript:alert(1)")).toBe(false);
    expect(isStorableFavicon("file:///etc/passwd")).toBe(false);
    expect(isStorableFavicon("data:text/html,<p>hi</p>")).toBe(false);
    expect(isStorableFavicon(`data:image/png;base64,${"A".repeat(16 * 1024)}`)).toBe(false);
    expect(isStorableFavicon(`https://example.com/i.png?${"q".repeat(4096)}`)).toBe(false);
  });
});

describe("isSameOrigin", () => {
  test("compares scheme, host and port", () => {
    expect(isSameOrigin("https://example.com/a", "https://example.com/b?c")).toBe(true);
    expect(isSameOrigin("https://example.com/", "http://example.com/")).toBe(false);
    expect(isSameOrigin("https://example.com/", "https://www.example.com/")).toBe(false);
    expect(isSameOrigin("http://localhost:3000/", "http://localhost:5173/")).toBe(false);
  });

  test("never matches an opaque origin or what doesn't parse", () => {
    expect(isSameOrigin("data:text/html,a", "data:text/html,a")).toBe(false);
    expect(isSameOrigin("about:blank", "about:blank")).toBe(false);
    expect(isSameOrigin("not a url", "not a url")).toBe(false);
  });
});
