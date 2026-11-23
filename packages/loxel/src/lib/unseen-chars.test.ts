import { describe, expect, test } from "bun:test";

import { hasKeyControl, revealUnseen } from "./unseen-chars";

describe("hasKeyControl", () => {
  test.each(["npm test", "claude 'line one\nline two'", "שלום", ""])(
    "accepts plain text and newlines: %p",
    (text) => {
      expect(hasKeyControl(text)).toBe(false);
    },
  );

  test.each(["a\tb", "a\rb", "a\u0015b", "a\u001bb", "a\u007fb", "a\u0085b", "\u0000"])(
    "finds a control character: %p",
    (text) => {
      expect(hasKeyControl(text)).toBe(true);
    },
  );
});

describe("revealUnseen", () => {
  test("spells format characters as escapes", () => {
    expect(revealUnseen("npm\u{13437} test\u0600").map((run) => run.text)).toEqual([
      "npm",
      "\\u{13437}",
      " test",
      "\\u0600",
    ]);
  });

  test("leaves printable text and newlines as one run", () => {
    expect(revealUnseen("npm test\nnpm run build")).toEqual([
      { text: "npm test\nnpm run build", unseen: false },
    ]);
  });

  test("spells control characters as escapes", () => {
    expect(revealUnseen("a\rb\tc\u0015\u001b")).toEqual([
      { text: "a", unseen: false },
      { text: "\\r", unseen: true },
      { text: "b", unseen: false },
      { text: "\\t", unseen: true },
      { text: "c", unseen: false },
      { text: "\\x15", unseen: true },
      { text: "\\e", unseen: true },
    ]);
  });

  test("spells bidirectional controls and zero-width characters as escapes", () => {
    expect(revealUnseen("x\u202ey\u200bz\u2066")).toEqual([
      { text: "x", unseen: false },
      { text: "\\u202e", unseen: true },
      { text: "y", unseen: false },
      { text: "\\u200b", unseen: true },
      { text: "z", unseen: false },
      { text: "\\u2066", unseen: true },
    ]);
  });

  test("spells other invisible characters as escapes, astral ones included", () => {
    expect(revealUnseen("a\u00adb\u{e0041}c").map((run) => run.text)).toEqual([
      "a",
      "\\xad",
      "b",
      "\\u{e0041}",
      "c",
    ]);
  });
});
