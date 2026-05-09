import type { MarkdownNode } from "@milkdown/kit/transformer";

import { describe, expect, it } from "bun:test";

import { extractDirectiveText, parseDirectiveAttrs } from "./schema";

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

    const attrs = parseDirectiveAttrs(extractDirectiveText(node));

    expect(attrs).toEqual({ table: "tasks", view: "kanban", viewId: "12" });
  });
});
