import { describe, expect, test } from "bun:test";

import { isStorableFavicon } from "./url-utils";

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
