import { describe, expect, test } from "bun:test";

import { addressBarUrl, webSearchUrl } from "./web-search";

describe("addressBarUrl", () => {
  test("keeps a web URL and the source view of one", () => {
    expect(addressBarUrl("  https://example.com/a?b=1 ")).toBe("https://example.com/a?b=1");
    expect(addressBarUrl("HTTP://example.com")).toBe("HTTP://example.com");
    expect(addressBarUrl("view-source:https://example.com")).toBe(
      "view-source:https://example.com",
    );
  });

  test("opens a domain-like word over https", () => {
    expect(addressBarUrl("example.com/docs")).toBe("https://example.com/docs");
    expect(addressBarUrl("localhost.test:3000")).toBe("https://localhost.test:3000");
  });

  test("searches anything else", () => {
    expect(addressBarUrl("how to rebase")).toBe(webSearchUrl("how to rebase"));
    expect(addressBarUrl("hello")).toBe(webSearchUrl("hello"));
    expect(addressBarUrl("node.js tutorial")).toBe(webSearchUrl("node.js tutorial"));
    expect(addressBarUrl("example.com/my file.pdf")).toBe(webSearchUrl("example.com/my file.pdf"));
  });
});
