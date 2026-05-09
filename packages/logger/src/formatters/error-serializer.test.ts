import { describe, expect, test } from "bun:test";

import { serializeError } from "./error-serializer.ts";

describe("serializeError", () => {
  test("serializes basic Error", () => {
    const error = new Error("Something went wrong");
    const result = serializeError(error);

    expect(result).toEqual({ name: "Error", message: "Something went wrong" });
  });

  test("serializes TypeError with name", () => {
    const error = new TypeError("Invalid type");
    const result = serializeError(error);

    expect(result).toEqual({ name: "TypeError", message: "Invalid type" });
  });

  test("serializes error with enumerable properties", () => {
    const error = new Error("Custom error");
    (error as Error & { code: string }).code = "ERR_CUSTOM";
    (error as Error & { statusCode: number }).statusCode = 500;

    const result = serializeError(error);

    expect(result).toEqual({
      name: "Error",
      message: "Custom error",
      props: { code: "ERR_CUSTOM", statusCode: 500 },
    });
  });

  test("serializes error with cause chain", () => {
    const rootCause = new Error("Root cause");
    const midCause = new Error("Mid level", { cause: rootCause });
    const topError = new Error("Top level error", { cause: midCause });

    const result = serializeError(topError);

    expect(result).toEqual({
      name: "Error",
      message: "Top level error",
      cause: {
        name: "Error",
        message: "Mid level",
        cause: { name: "Error", message: "Root cause" },
      },
    });
  });

  test("limits cause chain depth to prevent infinite loops", () => {
    // Create a deep cause chain (more than MAX_CAUSE_DEPTH)
    let error: Error = new Error("Level 0");
    for (let i = 1; i <= 15; i++) {
      error = new Error(`Level ${i}`, { cause: error });
    }

    const result = serializeError(error);

    // Count the depth
    let depth = 0;
    let current = result;
    while (current?.cause) {
      depth++;
      current = current.cause;
    }

    // Should be limited to MAX_CAUSE_DEPTH (10)
    expect(depth).toBeLessThanOrEqual(10);
    expect(current?.name).toBe("MaxDepthExceeded");
  });

  test("handles string thrown as error", () => {
    const result = serializeError("String error message");

    expect(result).toEqual({ name: "StringError", message: "String error message" });
  });

  test("handles object thrown as error", () => {
    const result = serializeError({ message: "Object error", code: 123 });

    expect(result).toEqual({ name: "UnknownError", message: "Object error" });
  });

  test("handles null/undefined", () => {
    expect(serializeError(null)).toBeUndefined();
    expect(serializeError(undefined)).toBeUndefined();
  });

  test("excludes stack from props", () => {
    const error = new Error("Test");
    // Stack is always present on Error
    expect(error.stack).toBeDefined();

    const result = serializeError(error);

    // Stack should not appear in props
    expect(result?.props?.stack).toBeUndefined();
  });

  test("redacts sensitive properties", () => {
    const error = new Error("Auth failed");
    (error as Error & { token: string }).token = "secret-token";
    (error as Error & { password: string }).password = "secret-password";
    (error as Error & { statusCode: number }).statusCode = 401;

    const result = serializeError(error);

    expect(result?.props?.token).toBe("[REDACTED]");
    expect(result?.props?.password).toBe("[REDACTED]");
    expect(result?.props?.statusCode).toBe(401);
  });
});
