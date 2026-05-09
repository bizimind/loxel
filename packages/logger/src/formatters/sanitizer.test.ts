import { describe, expect, test } from "bun:test";

import { sanitizeValue, sanitizeContext } from "./sanitizer.ts";

describe("sanitizeValue", () => {
  test("passes through primitives", () => {
    expect(sanitizeValue(42)).toBe(42);
    expect(sanitizeValue("hello")).toBe("hello");
    expect(sanitizeValue(true)).toBe(true);
    expect(sanitizeValue(null)).toBe(null);
    expect(sanitizeValue(undefined)).toBe(undefined);
  });

  test("redacts sensitive keys", () => {
    expect(sanitizeValue("secret123", "password")).toBe("[REDACTED]");
    expect(sanitizeValue("bearer-token", "token")).toBe("[REDACTED]");
    expect(sanitizeValue("my-secret", "secret")).toBe("[REDACTED]");
    expect(sanitizeValue("auth-value", "auth")).toBe("[REDACTED]");
    expect(sanitizeValue("cred-value", "credential")).toBe("[REDACTED]");
    expect(sanitizeValue("bearer-value", "bearer")).toBe("[REDACTED]");
    expect(sanitizeValue("header-value", "authorization")).toBe("[REDACTED]");
    expect(sanitizeValue("key-value", "api_key")).toBe("[REDACTED]");
    expect(sanitizeValue("key-value", "apikey")).toBe("[REDACTED]");
    expect(sanitizeValue("secret-value", "client_secret")).toBe("[REDACTED]");
  });

  test("redacts sensitive keys case-insensitively", () => {
    expect(sanitizeValue("secret123", "PASSWORD")).toBe("[REDACTED]");
    expect(sanitizeValue("secret123", "Token")).toBe("[REDACTED]");
    expect(sanitizeValue("secret123", "API_KEY")).toBe("[REDACTED]");
  });

  test("truncates long strings", () => {
    const longString = "a".repeat(15000);
    const result = sanitizeValue(longString) as string;

    expect(result.length).toBeLessThan(longString.length);
    expect(result.endsWith("...[TRUNCATED]")).toBe(true);
  });

  test("handles binary data", () => {
    const buffer = new ArrayBuffer(8);
    expect(sanitizeValue(buffer)).toBe("[BINARY DATA]");

    const uint8 = new Uint8Array(8);
    expect(sanitizeValue(uint8)).toBe("[BINARY DATA]");

    const buffer2 = Buffer.from("hello");
    expect(sanitizeValue(buffer2)).toBe("[BINARY DATA]");
  });

  test("handles functions", () => {
    const fn = () => {};
    expect(sanitizeValue(fn)).toBe("[FUNCTION]");
  });

  test("handles symbols", () => {
    const sym = Symbol("test");
    expect(sanitizeValue(sym)).toBe("[SYMBOL]");
  });

  test("handles dates", () => {
    const date = new Date("2024-01-15T10:30:00.000Z");
    expect(sanitizeValue(date)).toBe("2024-01-15T10:30:00.000Z");
  });

  test("sanitizes arrays", () => {
    const arr = [1, "hello", { password: "secret" }];
    const result = sanitizeValue(arr);

    expect(result).toEqual([1, "hello", { password: "[REDACTED]" }]);
  });

  test("sanitizes nested objects", () => {
    const obj = { name: "test", config: { token: "secret-token", port: 8080 } };

    const result = sanitizeValue(obj);

    expect(result).toEqual({ name: "test", config: { token: "[REDACTED]", port: 8080 } });
  });

  test("limits recursion depth", () => {
    const deepObj: Record<string, unknown> = { level: 0 };
    let current = deepObj;
    for (let i = 1; i <= 10; i++) {
      current.nested = { level: i };
      current = current.nested as Record<string, unknown>;
    }

    const result = sanitizeValue(deepObj) as Record<string, unknown>;

    // Should stop at some depth with [MAX DEPTH]
    let depth = 0;
    let node = result;
    while (node && typeof node === "object" && "nested" in node) {
      depth++;
      node = node.nested as Record<string, unknown>;
    }

    expect(depth).toBeLessThanOrEqual(6);
  });
});

describe("sanitizeContext", () => {
  test("sanitizes context object", () => {
    const context = { userId: "user123", token: "secret-token", port: 8080 };

    const result = sanitizeContext(context);

    expect(result).toEqual({ userId: "user123", token: "[REDACTED]", port: 8080 });
  });

  test("returns undefined for undefined input", () => {
    expect(sanitizeContext(undefined)).toBeUndefined();
  });
});
