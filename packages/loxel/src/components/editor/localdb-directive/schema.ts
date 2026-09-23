import type { NodeType, Node } from "@milkdown/kit/prose/model";
import type { ParserState, SerializerState, MarkdownNode } from "@milkdown/kit/transformer";
import { $nodeSchema } from "@milkdown/kit/utils";

import type { LocalDbBlockNode } from "./remark-plugin.ts";

/** Directive lines the widget understands; everything else is preserved verbatim in `extra`. */
const KNOWN_KEYS = new Set(["table", "view", "viewId"]);

/**
 * ProseMirror node for :::localdb directives.
 *
 * Attrs:
 *   table    — table name (required)
 *   view     — view type hint ("table" | "kanban" | "form" | etc.)
 *   viewId   — numeric id of a saved ViewDef (optional, null if unset)
 *   extra    — remaining directive body lines the widget does not understand, kept verbatim so
 *              a round-trip through the editor never drops content
 *   closed   — whether the source fence had its own closing `:::`; when false the serializer
 *              omits it (see LocalDbBlockNode.closed)
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
    extra: { default: "", validate: "string" },
    closed: { default: true, validate: "boolean" },
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
          extra: dom.getAttribute("data-extra") ?? "",
          closed: dom.getAttribute("data-closed") !== "false",
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
      "data-extra": node.attrs.extra as string,
      "data-closed": String(node.attrs.closed as boolean),
    },
  ],
  parseMarkdown: {
    match: ({ type }: { type: string }) => type === "localdb-block",
    runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
      const { raw, closed } = sourceBodyOf(node);
      const { attrs, extra } = parseDirectiveBody(raw ?? extractDirectiveText(node));
      state.addNode(type, {
        table: attrs["table"] ?? "",
        view: attrs["view"] ?? "table",
        viewId: attrs["viewId"] !== undefined ? Number(attrs["viewId"]) : null,
        extra,
        closed,
      });
    },
  },
  toMarkdown: {
    match: (node: Node) => node.type.name === "localdb-block",
    runner: (state: SerializerState, node: Node) => {
      const lines = [`table: ${node.attrs.table as string}`, `view: ${node.attrs.view as string}`];
      if (node.attrs.viewId !== null && node.attrs.viewId !== undefined)
        lines.push(`viewId: ${node.attrs.viewId as number}`);
      const extra = node.attrs.extra as string;
      if (extra) lines.push(extra);
      // An `html` node is written verbatim by mdast-util-to-markdown, whereas `text` would be
      // escaped (e.g. `# heading` → `\# heading`) and could corrupt preserved lines.
      if (node.attrs.closed === false) {
        // No closing fence of its own in the source (see LocalDbBlockNode.closed): emit the
        // opening fence and body verbatim instead of letting the directive handler close it.
        state.addNode("html", undefined, [":::localdb", ...lines].join("\n"));
        return;
      }
      state.openNode("containerDirective", undefined, { name: "localdb" });
      state.addNode("html", undefined, lines.join("\n"));
      state.closeNode();
    },
  },
}));

/** Verbatim body and fence state attached by remarkLocalDbDirective when the source was available. */
function sourceBodyOf(node: MarkdownNode): { raw: string | null; closed: boolean } {
  const { raw, closed }: Partial<LocalDbBlockNode> = node as Partial<LocalDbBlockNode>;
  return { raw: typeof raw === "string" ? raw : null, closed: closed !== false };
}

export function extractDirectiveText(node: MarkdownNode): string {
  const children = (node as { children?: MarkdownNode[] }).children;
  if (!children) return "";
  return children.map(extractText).join("\n");
}

/**
 * Splits a directive body into the known `key: value` attrs and the remaining lines.
 * Unknown lines (other keys, prose, blank lines) are returned verbatim in `extra`, trimmed of
 * trailing blank lines, so they can be re-emitted on serialize.
 */
export function parseDirectiveBody(text: string): { attrs: Record<string, string>; extra: string } {
  const attrs: Record<string, string> = {};
  const rest: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
    const key = match?.[1];
    // A repeated known key is kept in `extra` rather than overwriting (and losing) the first.
    if (match && key !== undefined && KNOWN_KEYS.has(key) && !(key in attrs)) {
      attrs[key] = match[2]!.trim();
      continue;
    }
    rest.push(line);
  }
  return { attrs, extra: rest.join("\n").replace(/\n+$/, "") };
}

function extractText(node: MarkdownNode): string {
  const value = (node as { value?: unknown }).value;
  if (typeof value === "string") return value;
  return extractDirectiveText(node);
}
