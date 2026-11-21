import { describe, expect, test } from "bun:test";

import { hasKeyControl, replaceUnseen, revealUnseen, sliceRuns } from "./unseen-chars";

const texts = (runs: { text: string }[]) => runs.map((run) => run.text);

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
  test("leaves printable text and newlines as one run", () => {
    expect(revealUnseen("npm test\nnpm run build")).toMatchObject([
      { text: "npm test\nnpm run build", unseen: false },
    ]);
  });

  test("spells control characters as escapes", () => {
    expect(revealUnseen("a\rb\tc\u0015\u001b")).toMatchObject([
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
    expect(revealUnseen("x\u202ey\u200bz\u2066")).toMatchObject([
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

  test("in content, keeps tabs and carriage returns but still spells bidirectional controls", () => {
    expect(texts(revealUnseen("\ta\u202e\r", { content: true }))).toEqual(["\ta", "\\u202e", "\r"]);
  });

  test("in content, keeps the joiners and selectors inside emoji sequences", () => {
    const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
    const check = "\u2714\ufe0f";
    const scotland = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}";
    const text = `// ${family} ${check} ${scotland}`;
    expect(texts(revealUnseen(text, { content: true }))).toEqual([text]);
    expect(revealUnseen(text).some((run) => run.unseen)).toBe(true);
  });

  test("in content, keeps a joiner between letters of a script spelled with it", () => {
    const persian = "\u0645\u06cc\u200c\u062e\u0648\u0627\u0646\u0645";
    expect(texts(revealUnseen(persian, { content: true }))).toEqual([persian]);
  });

  test("in content, still spells a joiner between Latin letters", () => {
    expect(texts(revealUnseen("ad\u200dmin", { content: true }))).toEqual(["ad", "\\u200d", "min"]);
  });
});

describe("sliceRuns", () => {
  test("slices by source offsets, keeping each escape with the character it stands for", () => {
    const runs = revealUnseen("ab\u202ecd");
    expect(texts(sliceRuns(runs, 0, 2))).toEqual(["ab"]);
    expect(texts(sliceRuns(runs, 1, 4))).toEqual(["b", "\\u202e", "c"]);
    expect(texts(sliceRuns(runs, 3, 5))).toEqual(["cd"]);
  });
});

describe("replaceUnseen", () => {
  test("renders each unseen character in place", () => {
    expect(replaceUnseen("<b>a\u202eb</b>\t", (escape) => `[${escape}]`)).toBe(
      "<b>a[\\u202e]b</b>[\\t]",
    );
  });
});
