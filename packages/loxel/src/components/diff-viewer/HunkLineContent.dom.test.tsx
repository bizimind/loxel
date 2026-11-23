import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import type { FileDiff } from "@/api/diff-model";

import { FileDiffHeader } from "./FileDiffHeader";
import { HunkLineContent } from "./HunkLineContent";

afterEach(cleanup);

const escapes = (container: HTMLElement) =>
  [...container.querySelectorAll(".unseen-char")].map((el) => el.textContent);

describe("HunkLineContent", () => {
  test("spells bidirectional controls in plain text as escapes, keeping tabs", () => {
    const { container } = render(
      <HunkLineContent
        line={{ type: "add", content: "\tif (a\u202e) {} \u2066", newLineNumber: 1 }}
        highlighted={false}
      />,
    );
    expect(escapes(container)).toEqual(["\\u202e", "\\u2066"]);
    expect(container.textContent).toBe("\tif (a\\u202e) {} \\u2066");
  });

  test("spells them in highlighted html, and in the inline-change layer at the same places", () => {
    const { container } = render(
      <HunkLineContent
        line={{
          type: "add",
          content: "a\u200bb",
          html: '<span style="color:red">a\u200bb</span>',
          newLineNumber: 1,
        }}
        highlighted
        segments={[{ startColumn: 1, endColumn: 4 }]}
      />,
    );
    const ghost = container.querySelector(".diff-inline-ghost");
    expect(ghost?.textContent).toBe("a\\u200bb");
    expect(escapes(container)).toEqual(["\\u200b", "\\u200b"]);
  });
});

describe("HunkLineContent in highlighted lines", () => {
  test("reveals what the source line reveals, however the markup splits the text", () => {
    const persian = "\u0645\u06cc\u200c\u062e\u0648\u0627\u0646\u0645";
    const { container } = render(
      <HunkLineContent
        line={{
          type: "add",
          content: `${persian}()`,
          html: "<span>\u0645\u06cc</span><span>\u200c</span><span>\u062e\u0648\u0627\u0646\u0645</span><span>()</span>",
          newLineNumber: 1,
        }}
        highlighted
        segments={[{ startColumn: 1, endColumn: 3 }]}
      />,
    );
    expect(escapes(container)).toEqual([]);
  });

  test("places escapes by source offset across tags and entities", () => {
    const { container } = render(
      <HunkLineContent
        line={{
          type: "add",
          content: "a<b\u202ec",
          html: "<span>a&lt;</span><span>b\u202ec</span>",
          newLineNumber: 1,
        }}
        highlighted
      />,
    );
    expect(escapes(container)).toEqual(["\\u202e"]);
    expect(container.textContent).toBe("a<b\\u202ec");
  });
});

describe("HunkLineContent in emoji", () => {
  test("keeps an emoji sequence whole, even with a change span ending inside it", () => {
    const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
    const { container } = render(
      <HunkLineContent
        line={{ type: "add", content: `x ${family}`, newLineNumber: 1 }}
        highlighted={false}
        segments={[{ startColumn: 1, endColumn: 6 }]}
      />,
    );
    expect(escapes(container)).toEqual([]);
  });
});

describe("FileDiffHeader", () => {
  test("spells a tab in the path as an escape", () => {
    const file: FileDiff = {
      oldPath: "src/a\tb.ts",
      newPath: "src/a\tb.ts",
      status: "modified",
      hunks: [],
      isBinary: false,
      additions: 0,
      deletions: 0,
    };
    const { container } = render(<FileDiffHeader file={file} />);
    expect(escapes(container)).toEqual(["\\t"]);
  });

  test("spells unseen characters in the path as escapes", () => {
    const file: FileDiff = {
      oldPath: "src/a\u202eb.ts",
      newPath: "src/a\u202eb.ts",
      status: "modified",
      hunks: [],
      isBinary: false,
      additions: 0,
      deletions: 0,
    };
    const { container } = render(<FileDiffHeader file={file} />);
    expect(escapes(container)).toEqual(["\\u202e"]);
  });
});
