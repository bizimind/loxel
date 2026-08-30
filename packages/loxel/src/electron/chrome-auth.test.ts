import { describe, expect, test } from "bun:test";

import { cookieDomainMatches, mapChromeCookie, validateTargetUrl } from "./chrome-auth";

function chromeCookie(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "session",
    value: "secret",
    domain: "example.com",
    path: "/",
    secure: true,
    httpOnly: true,
    session: false,
    expires: 2_000,
    sameSite: "Lax",
    ...overrides,
  };
}

const HTTPS_EXAMPLE = new URL("https://example.com/account");

describe("validateTargetUrl", () => {
  test("accepts HTTP(S), strips fragments, and preserves the rest", () => {
    expect(validateTargetUrl("https://example.com/path?q=1#section").href).toBe(
      "https://example.com/path?q=1",
    );
    expect(validateTargetUrl("http://localhost:7433/").href).toBe("http://localhost:7433/");
  });

  test("rejects non-web URLs and embedded credentials", () => {
    expect(() => validateTargetUrl("file:///etc/passwd")).toThrow();
    expect(() => validateTargetUrl("https://user:password@example.com")).toThrow();
    expect(() => validateTargetUrl("https://example.com/" + "a".repeat(4_096))).toThrow();
  });
});

describe("cookieDomainMatches", () => {
  test("uses exact or dot-boundary domain matching", () => {
    expect(cookieDomainMatches("example.com", ".example.com")).toBe(true);
    expect(cookieDomainMatches("accounts.example.com", "example.com")).toBe(true);
    expect(cookieDomainMatches("notexample.com", "example.com")).toBe(false);
    expect(cookieDomainMatches("example.com.evil.test", "example.com")).toBe(false);
  });

  test("requires exact matching for IP addresses", () => {
    expect(cookieDomainMatches("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(cookieDomainMatches("127.0.0.1", "0.0.1")).toBe(false);
    expect(cookieDomainMatches("[::1]", "[::1]")).toBe(true);
  });
});

describe("mapChromeCookie", () => {
  test("preserves supported host-only cookie properties", () => {
    expect(mapChromeCookie(chromeCookie(), [HTTPS_EXAMPLE], 1_000)).toEqual({
      url: "https://example.com/",
      name: "session",
      value: "secret",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      expirationDate: 2_000,
    });
  });

  test("preserves domain scope and session-cookie semantics", () => {
    expect(
      mapChromeCookie(
        chromeCookie({ domain: ".example.com", session: true, expires: -1, sameSite: "Strict" }),
        [new URL("https://sub.example.com/")],
      ),
    ).toEqual({
      url: "https://sub.example.com/",
      name: "session",
      value: "secret",
      domain: ".example.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "strict",
    });
  });

  test("rejects cookies outside the approved hosts and mismatched host-only cookies", () => {
    expect(mapChromeCookie(chromeCookie({ domain: ".other.test" }), [HTTPS_EXAMPLE])).toBeNull();
    expect(
      mapChromeCookie(chromeCookie({ domain: "sub.example.com" }), [HTTPS_EXAMPLE]),
    ).toBeNull();
  });

  test("rejects expired or malformed persistent cookies", () => {
    expect(mapChromeCookie(chromeCookie({ expires: 999 }), [HTTPS_EXAMPLE], 1_000)).toBeNull();
    expect(mapChromeCookie(chromeCookie({ expires: -1 }), [HTTPS_EXAMPLE], 1_000)).toBeNull();
    expect(mapChromeCookie(chromeCookie({ expires: "later" }), [HTTPS_EXAMPLE])).toBeNull();
  });

  test("rejects unsupported partitioned cookies", () => {
    expect(
      mapChromeCookie(chromeCookie({ partitionKey: { topLevelSite: "https://example.com" } }), [
        HTTPS_EXAMPLE,
      ]),
    ).toBeNull();
    expect(mapChromeCookie(chromeCookie({ partitionKeyOpaque: true }), [HTTPS_EXAMPLE])).toBeNull();
  });

  test("enforces secure cookie prefix and SameSite requirements", () => {
    expect(
      mapChromeCookie(chromeCookie({ name: "__Secure-token", secure: false }), [HTTPS_EXAMPLE]),
    ).toBeNull();
    expect(
      mapChromeCookie(chromeCookie({ name: "__Host-token", domain: ".example.com" }), [
        HTTPS_EXAMPLE,
      ]),
    ).toBeNull();
    expect(
      mapChromeCookie(chromeCookie({ name: "__Host-token", path: "/account" }), [HTTPS_EXAMPLE]),
    ).toBeNull();
    expect(
      mapChromeCookie(chromeCookie({ sameSite: "None", secure: false }), [HTTPS_EXAMPLE]),
    ).toBeNull();
  });

  test("maps SameSite=None only for secure cookies", () => {
    expect(
      mapChromeCookie(chromeCookie({ sameSite: "None" }), [HTTPS_EXAMPLE], 1_000)?.sameSite,
    ).toBe("no_restriction");
  });
});
