import { describe, expect, it } from "bun:test";

import type { MarkdownNode } from "@milkdown/kit/transformer";

import { extractDirectiveText, parseDirectiveBody } from "./schema";

describe("localdb directive schema helpers", () => {
  it("extracts attrs from nested directive paragraph text", () => {
    const node = {
      type: "localdb-block",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", value: "table: tasks\nview: kanban\nviewId: 12" }],
        },
      ],
    } as MarkdownNode;

    const { attrs, extra } = parseDirectiveBody(extractDirectiveText(node));

    expect(attrs).toEqual({ table: "tasks", view: "kanban", viewId: "12" });
    expect(extra).toBe("");
  });

  it("preserves unknown keys and non key:value lines verbatim in extra", () => {
    const { attrs, extra } = parseDirectiveBody(
      "table: tasks\ncolor: red\n\nafter paragraph\n# heading\nview: table\n",
    );

    expect(attrs).toEqual({ table: "tasks", view: "table" });
    expect(extra).toBe("color: red\n\nafter paragraph\n# heading");
  });

  it("keeps repeated known keys in extra instead of overwriting the first", () => {
    const { attrs, extra } = parseDirectiveBody("table: first\ntable: second\nview: table\n");

    expect(attrs).toEqual({ table: "first", view: "table" });
    expect(extra).toBe("table: second");
  });

  it("keeps the swallowed remainder of an unclosed fence", () => {
    const { attrs, extra } = parseDirectiveBody("table: tasks\n\nafter paragraph\n");

    expect(attrs).toEqual({ table: "tasks" });
    expect(extra).toBe("\nafter paragraph");
  });
});
