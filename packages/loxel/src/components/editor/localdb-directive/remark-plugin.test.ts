import { describe, expect, it } from "bun:test";

import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";

import { remarkLocalDbDirective, transformDirectives } from "./remark-plugin";

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkStringify, { bullet: "-", emphasis: "_", fences: true, rule: "-" })
  .use(remarkLocalDbDirective);

function parse(markdown: string): Root {
  // runSync is typed as returning a generic Node; remark-parse always yields a Root.
  return processor.runSync(processor.parse(markdown), markdown) as Root;
}

function roundTrip(markdown: string): string {
  return processor.stringify(parse(markdown));
}

function nodeTypes(tree: Root): string[] {
  const out: string[] = [];
  const walk = (node: { type: string; children?: unknown }) => {
    out.push(node.type);
    if (Array.isArray(node.children)) {
      for (const child of node.children as Array<{ type: string }>) walk(child);
    }
  };
  walk(tree);
  return out;
}

describe("remarkLocalDbDirective", () => {
  it("does not recognize text directives, so prose with colons stays plain text", () => {
    for (const md of ["Meeting at 10:30am\n", "key:value\n", "see :smile: and a::b\n"]) {
      const tree = parse(md);
      expect(nodeTypes(tree)).toEqual(["root", "paragraph", "text"]);
      expect(roundTrip(md)).toBe(md);
    }
  });

  it("converts :::localdb containers into localdb-block nodes with the verbatim body", () => {
    const md = "before\n\n:::localdb\ntable: tasks\nview: kanban\n:::\n\nafter\n";
    const tree = parse(md);
    expect(nodeTypes(tree)).toEqual([
      "root",
      "paragraph",
      "text",
      "localdb-block",
      "paragraph",
      "text",
      "paragraph",
      "text",
    ]);
    const block = tree.children[1] as unknown as { raw: string };
    expect(block.raw).toBe("table: tasks\nview: kanban");
  });

  it("keeps the swallowed remainder of an unclosed :::localdb fence in the block body", () => {
    const md = "before\n\n:::localdb\ntable: tasks\n\nafter paragraph\n";
    const block = parse(md).children[1] as unknown as {
      type: string;
      raw: string;
      closed: boolean;
    };
    expect(block.type).toBe("localdb-block");
    expect(block.raw).toBe("table: tasks\n\nafter paragraph");
    expect(block.closed).toBe(false);
  });

  it("marks a localdb fence whose closing ::: belongs to an outer container as unclosed", () => {
    const tree = parse(":::a\n:::localdb\ntable: t\n:::\n:::\n");
    const block = tree.children[1] as unknown as { type: string; raw: string; closed: boolean };
    expect(block.type).toBe("localdb-block");
    expect(block.raw).toBe("table: t");
    expect(block.closed).toBe(false);
    // micromark closes the outer container with the first `:::`; the second is a stray paragraph.
    expect(nodeTypes(tree)).toEqual([
      "root",
      "paragraph",
      "text",
      "localdb-block",
      "paragraph",
      "text",
      "paragraph",
      "text",
      "paragraph",
      "text",
    ]);
  });

  it("dedents a localdb block nested in a list", () => {
    const md = "- item\n  :::localdb\n  table: tasks\n  :::\n";
    const tree = parse(md);
    const list = tree.children[0] as { children: Array<{ children: unknown[] }> };
    const block = list.children[0]!.children[1] as { type: string; raw: string };
    expect(block.type).toBe("localdb-block");
    expect(block.raw).toBe("table: tasks");
  });

  it("strips the block-quote prefix from a localdb body and round-trips it byte-identically", () => {
    const md = "> :::localdb\n> table: tasks\n>\n> view: kanban\n> :::\n";
    const quote = parse(md).children[0] as { children: Array<{ type: string; raw?: string }> };
    expect(quote.children[0]!.type).toBe("localdb-block");
    expect(quote.children[0]!.raw).toBe("table: tasks\n\nview: kanban");
  });

  it("strips mixed block-quote and list prefixes from a localdb body", () => {
    for (const md of [
      "> - :::localdb\n>   table: t\n>   :::\n",
      "- > :::localdb\n  > table: t\n  > :::\n",
      "> 1. :::localdb\n>    table: t\n>    :::\n",
    ]) {
      const blocks: Array<{ raw?: string; closed?: boolean }> = [];
      visit(parse(md), "localdb-block", (node) => {
        blocks.push(node as { raw?: string; closed?: boolean });
      });
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.raw).toBe("table: t");
      expect(blocks[0]!.closed).toBe(true);
    }
  });

  it("keeps the closing fence of unwrapped directives under mixed container prefixes", () => {
    for (const md of [
      "> - :::note\n>   hi\n>   :::\n",
      "- > :::note\n  > hi\n  > :::\n",
      "> 1. :::note\n>    hi\n>    :::\n",
    ]) {
      const once = roundTrip(md);
      expect(once).toContain(":::note");
      expect(once.trimEnd().endsWith(":::")).toBe(true);
      expect(roundTrip(once)).toBe(once);
    }
  });

  it("keeps the closing fence of unwrapped directives inside block quotes and lists", () => {
    expect(roundTrip("> :::note\n> hi\n> :::\n\nafter\n")).toBe(
      "> :::note\n>\n> hi\n>\n> :::\n\nafter\n",
    );
    expect(roundTrip("1. one\n2. two\n   :::note\n   hi\n   :::\n")).toBe(
      "1. one\n2. two\n\n   :::note\n\n   hi\n\n   :::\n",
    );
    expect(roundTrip("- item\n  :::note\n  hi\n  :::\n")).toBe(
      "- item\n\n  :::note\n\n  hi\n\n  :::\n",
    );
  });

  it("unwraps other container directives into paragraphs that survive a round-trip", () => {
    const md = ":::note[Label]{a=1}\nhi *there*\n\n- x\n:::\n";
    const tree = parse(md);
    expect(nodeTypes(tree)).not.toContain("containerDirective");
    // Block-level content is canonicalized like any other paragraph (blank lines between
    // blocks, `[` escaped), but nothing is lost and the result is stable on re-serialize.
    const once = roundTrip(md);
    expect(once).toBe(":::note\\[Label]{a=1}\n\nhi _there_\n\n- x\n\n:::\n");
    expect(roundTrip(once)).toBe(once);
    expect(nodeTypes(parse(once))).not.toContain("containerDirective");
  });

  it("unwraps leaf directives and unclosed containers without losing text", () => {
    expect(roundTrip("a\n\n::hr\n\nb\n")).toBe("a\n\n::hr\n\nb\n");
    expect(roundTrip(":::note\nhi\n")).toBe(":::note\n\nhi\n");
    expect(nodeTypes(parse(":::note\nhi\n"))).toEqual([
      "root",
      "paragraph",
      "text",
      "paragraph",
      "text",
    ]);
  });

  it("gives unwrapped fence paragraphs source positions on their own lines", () => {
    const tree = parse("x\n\n:::note\nhi\n:::\n");
    const opening = tree.children[1]!;
    const closing = tree.children[3]!;
    expect(opening.position?.start.line).toBe(3);
    expect(opening.position?.end.line).toBe(3);
    expect(closing.position?.start.line).toBe(5);
    expect(closing.position?.end.line).toBe(5);
  });

  it("reconstructs directive syntax when the source is unavailable", () => {
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "containerDirective",
          name: "note",
          attributes: { a: "1", flag: "" },
          children: [
            {
              type: "paragraph",
              data: { directiveLabel: true },
              children: [{ type: "text", value: "Lbl" }],
            },
            { type: "paragraph", children: [{ type: "text", value: "hi" }] },
          ],
        },
        { type: "leafDirective", name: "hr", attributes: {}, children: [] },
        {
          type: "paragraph",
          children: [
            { type: "text", value: "a " },
            {
              type: "textDirective",
              name: "b",
              attributes: {},
              children: [{ type: "text", value: "c" }],
            },
          ],
        },
      ],
    };
    transformDirectives(tree, null);
    expect(processor.stringify(tree)).toBe(
      ':::note\\[Lbl]{a="1" flag}\n\nhi\n\n:::\n\n::hr\n\na :b\\[c]\n',
    );
  });

  it("writes html nodes verbatim, including inside list items", () => {
    const tree = parse("- x\n");
    const item = (tree.children[0] as { children: Array<{ children: unknown[] }> }).children[0]!;
    item.children.push({
      type: "html",
      value: "::::localdb\ntable: t\n\n# not escaped\n:::\n::::",
    });
    expect(processor.stringify(tree)).toBe(
      "- x\n  ::::localdb\n  table: t\n\n  # not escaped\n  :::\n  ::::\n",
    );
  });
});
