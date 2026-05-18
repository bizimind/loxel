import type { NodeType, Node } from "@milkdown/kit/prose/model";
import type { ParserState, SerializerState, MarkdownNode } from "@milkdown/kit/transformer";
import { $nodeSchema } from "@milkdown/kit/utils";

/**
 * ProseMirror node for :::localdb directives.
 *
 * Attrs:
 *   table    — table name (required)
 *   view     — view type hint ("table" | "kanban" | "form" | etc.)
 *   viewId   — numeric id of a saved ViewDef (optional, null if unset)
 */
export const localDbBlockSchema = $nodeSchema("localdb-block", () => ({
  inline: false,
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  isolating: true,
  marks: "",
  attrs: {
    table: { default: "", validate: "string" },
    view: { default: "table", validate: "string" },
    viewId: { default: null },
  },
  parseDOM: [
    {
      tag: 'div[data-type="localdb-block"]',
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false;
        return {
          table: dom.getAttribute("data-table") ?? "",
          view: dom.getAttribute("data-view") ?? "table",
          viewId: dom.getAttribute("data-view-id")
            ? Number(dom.getAttribute("data-view-id"))
            : null,
        };
      },
    },
  ],
  toDOM: (node: Node) => [
    "div",
    {
      "data-type": "localdb-block",
      "data-table": node.attrs.table as string,
      "data-view": node.attrs.view as string,
      "data-view-id": node.attrs.viewId !== null ? String(node.attrs.viewId) : "",
    },
  ],
  parseMarkdown: {
    match: ({ type }: { type: string }) => type === "localdb-block",
    runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
      const rawText = extractDirectiveText(node);
      const attrs = parseDirectiveAttrs(rawText);
      state.addNode(type, {
        table: attrs["table"] ?? "",
        view: attrs["view"] ?? "table",
        viewId:
          attrs["viewId"] !== null && attrs["viewId"] !== undefined
            ? Number(attrs["viewId"])
            : null,
      });
    },
  },
  toMarkdown: {
    match: (node: Node) => node.type.name === "localdb-block",
    runner: (state: SerializerState, node: Node) => {
      const lines = [`table: ${node.attrs.table as string}`, `view: ${node.attrs.view as string}`];
      if (node.attrs.viewId !== null && node.attrs.viewId !== undefined)
        lines.push(`viewId: ${node.attrs.viewId as number}`);
      state.openNode("containerDirective", undefined, { name: "localdb" });
      state.addNode("text", undefined, lines.join("\n"));
      state.closeNode();
    },
  },
}));

export function extractDirectiveText(node: MarkdownNode): string {
  const children = (node as { children?: MarkdownNode[] }).children;
  if (!children) return "";
  return children.map(extractText).join("\n");
}

export function parseDirectiveAttrs(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function extractText(node: MarkdownNode): string {
  const value = (node as { value?: unknown }).value;
  if (typeof value === "string") return value;
  return extractDirectiveText(node);
}
