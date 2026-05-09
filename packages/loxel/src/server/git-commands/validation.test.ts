import { describe, expect, test } from "bun:test";

import { validateCommitHash, validatePath, validateRefName } from "./validation";

describe("validateCommitHash", () => {
  test.each(["abcd", "abc123def456789012345678901234567890abcd", "ABCD1234", "a1b2c3d4"])(
    "accepts valid hash: %s",
    (hash) => {
      expect(() => validateCommitHash(hash)).not.toThrow();
    },
  );

  test.each([
    ["abc", "too short"],
    ["xyz123", "non-hex chars"],
    ["abcd; rm -rf /", "injection"],
    ["", "empty"],
    ["a".repeat(41), "too long"],
  ])("rejects %s (%s)", (hash) => {
    expect(() => validateCommitHash(hash)).toThrow("Invalid commit hash");
  });
});

describe("validateRefName", () => {
  test.each(["main", "feature/foo", "refs/heads/main", "v1.0.0", "HEAD"])(
    "accepts valid ref: %s",
    (ref) => {
      expect(() => validateRefName(ref)).not.toThrow();
    },
  );

  test.each([
    ["main; echo pwned", "injection"],
    ["branch name", "space"],
    ["", "empty"],
    ["ref\x00null", "null byte"],
  ])("rejects %s (%s)", (ref) => {
    expect(() => validateRefName(ref)).toThrow("Invalid ref name");
  });
});

describe("validatePath", () => {
  test.each(["src/main.ts", "file.txt", "deeply/nested/dir/file.js"])(
    "accepts valid path: %s",
    (p) => {
      expect(() => validatePath(p)).not.toThrow();
    },
  );

  test.each([
    ["../etc/passwd", "parent traversal"],
    ["src/../../etc/passwd", "nested traversal"],
    ["file\x00.txt", "null byte"],
    ['file"|rm.txt', "pipe char"],
  ])("rejects %s (%s)", (p) => {
    expect(() => validatePath(p)).toThrow("Invalid path");
  });
});
