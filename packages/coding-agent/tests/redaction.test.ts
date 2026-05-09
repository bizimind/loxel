import { describe, expect, test } from "bun:test";

import { redactSecrets } from "../src/utils/redaction.ts";

describe("redactSecrets", () => {
  test("redacts OpenRouter-style keys recursively", () => {
    const payload = {
      token: "sk-or-v1-abcdefghijklmnopqrstuvwxyz",
      nested: [{ auth: "Bearer abcdefghijklmnopqrstuvwxyz123456" }],
    };
    const redacted = redactSecrets(payload);
    expect(JSON.stringify(redacted).includes("sk-or-v1-abcdefghijklmnopqrstuvwxyz")).toBe(false);
    expect(JSON.stringify(redacted).includes("[REDACTED]")).toBe(true);
  });
});
