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

describe("FileDiffHeader", () => {
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
