import { $remark } from "@milkdown/kit/utils";
import type { Paragraph, Root, RootContent, Text } from "mdast";
import type { ContainerDirective, LeafDirective, TextDirective } from "mdast-util-directive";
import { directiveFromMarkdown, directiveToMarkdown } from "mdast-util-directive";
import { directive } from "micromark-extension-directive";
import type { Plugin } from "unified";
import type { Position } from "unist";
import { SKIP, visit } from "unist-util-visit";

type Directive = ContainerDirective | LeafDirective | TextDirective;

/** mdast node produced for `:::localdb` containers, consumed by localDbBlockSchema. */
export interface LocalDbBlockNode {
  type: "localdb-block";
  /** Verbatim inner source of the fence (without the fence lines), when the source was available. */
  raw?: string;
  children: RootContent[];
  position?: Position;
}

const CLOSING_FENCE = /^\s*:::+\s*$/;

/**
 * Directive syntax for the markdown pipeline, restricted to what the editor understands:
 *
 * - Parses only *flow* directives (`:::container` / `::leaf`). Text directives (`:name`) are
 *   never recognized, so prose like `10:30am` or `key:value` stays plain text and needs no escaping.
 * - `:::localdb` containers become `localdb-block` nodes carrying their verbatim inner source.
 * - Every other directive is unwrapped into plain paragraphs reproducing its source so no text is
 *   lost and Milkdown's transformer never sees an unknown node type.
 * - Serialization keeps the `containerDirective` handler (used by localDbBlockSchema) but drops
 *   remark-directive's `:` escaping rules, which only matter when text directives are parsed.
 */
export const remarkLocalDbDirective: Plugin<[], Root> = function remarkLocalDbDirective() {
  const data = this.data();
  const micromarkExtensions = data.micromarkExtensions ?? (data.micromarkExtensions = []);
  const fromMarkdownExtensions = data.fromMarkdownExtensions ?? (data.fromMarkdownExtensions = []);
  const toMarkdownExtensions = data.toMarkdownExtensions ?? (data.toMarkdownExtensions = []);

  const { flow } = directive();
  micromarkExtensions.push({ flow });
  fromMarkdownExtensions.push(directiveFromMarkdown());
  const containerDirective = directiveToMarkdown().handlers?.containerDirective;
  if (!containerDirective)
    throw new Error("mdast-util-directive has no containerDirective handler");
  toMarkdownExtensions.push({ handlers: { containerDirective } });

  return (tree, file) => transformDirectives(tree, sourceOf(file));
};

/** Milkdown plugin wrapper around {@link remarkLocalDbDirective}. */
export const remarkLocalDbPlugin = $remark("remark-localdb", () => remarkLocalDbDirective);

function sourceOf(file: unknown): string | null {
  if (typeof file === "string") return file;
  if (file && typeof file === "object" && "value" in file && typeof file.value === "string") {
    return file.value;
  }
  return null;
}

function isDirective(node: { type: string }): node is Directive {
  return (
    node.type === "containerDirective" ||
    node.type === "leafDirective" ||
    node.type === "textDirective"
  );
}

/** Rewrites directive nodes in place. Exported for tests and for the search-position mapper. */
export function transformDirectives(tree: Root, source: string | null): void {
  visit(tree, (node, index, parent) => {
    if (!isDirective(node) || index === undefined || !parent) return;

    const isLocalDb = node.type === "containerDirective" && node.name === "localdb";
    const replacement: Array<RootContent | LocalDbBlockNode> = isLocalDb
      ? [toLocalDbBlock(node, source)]
      : unwrapDirective(node, source);
    // The parent's children union does not include our custom node type; the cast is limited
    // to the splice since Milkdown's parser dispatches on `type` at runtime.
    parent.children.splice(index, 1, ...(replacement as RootContent[]));
    // Skip over the localdb node; revisit unwrapped children since they may contain directives.
    return isLocalDb ? [SKIP, index + 1] : index;
  });
}

/**
 * Converts `:::localdb` into a `localdb-block`. The verbatim inner source is kept so unknown
 * lines (or, for an unclosed fence, the swallowed remainder of the document) survive a round-trip.
 */
function toLocalDbBlock(node: ContainerDirective, source: string | null): LocalDbBlockNode {
  const block: LocalDbBlockNode = { type: "localdb-block", children: node.children };
  if (node.position) block.position = node.position;
  const lines = sourceLines(node, source);
  if (!lines) return block;

  // Inner lines carry the container's indentation (e.g. inside a list item); the opening fence
  // line does not, since the node's start offset points at the first colon.
  const indent = (node.position?.start.column ?? 1) - 1;
  const dedent = (line: string) => line.slice(Math.min(indent, /^\s*/.exec(line)![0].length));
  const inner = lines.slice(1);
  const closed = inner.length > 0 && CLOSING_FENCE.test(inner[inner.length - 1] ?? "");
  block.raw = (closed ? inner.slice(0, -1) : inner).map(dedent).join("\n");
  return block;
}

/** Replaces a non-localdb directive with plain nodes that reproduce its source. */
function unwrapDirective(node: Directive, source: string | null): RootContent[] {
  if (node.type === "textDirective") {
    return [text(sourceText(node, source) ?? reconstructOpening(node), node.position)];
  }
  if (node.type === "leafDirective") {
    return [paragraph(sourceText(node, source) ?? reconstructOpening(node), node.position)];
  }

  const lines = sourceLines(node, source);
  const opening = lines?.[0] ?? reconstructOpening(node);
  const closing = lines === null ? ":::" : lines.length > 1 ? lines[lines.length - 1] : undefined;
  const body = node.children.filter((child) => !isDirectiveLabel(child));

  const out: RootContent[] = [paragraph(opening, lineRange(node.position, "start")), ...body];
  if (closing !== undefined && CLOSING_FENCE.test(closing)) {
    out.push(paragraph(closing, lineRange(node.position, "end")));
  }
  return out;
}

function isDirectiveLabel(node: RootContent): boolean {
  return node.type === "paragraph" && node.data?.directiveLabel === true;
}

function sourceText(node: Directive, source: string | null): string | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (source === null || start === undefined || end === undefined) return null;
  return source.slice(start, end);
}

function sourceLines(node: Directive, source: string | null): string[] | null {
  const raw = sourceText(node, source);
  return raw === null ? null : raw.split(/\r?\n/);
}

/** Rebuilds `:name[label]{attrs}` when the source text is unavailable. */
function reconstructOpening(node: Directive): string {
  const colons =
    node.type === "containerDirective" ? ":::" : node.type === "leafDirective" ? "::" : ":";
  const labelNodes =
    node.type === "containerDirective" ? node.children.filter(isDirectiveLabel) : node.children;
  const label = labelNodes.map(plainText).join("");
  const attrs = Object.entries(node.attributes ?? {})
    .map(([key, value]) => (value === "" || value === null ? key : `${key}="${value}"`))
    .join(" ");
  return `${colons}${node.name}${label ? `[${label}]` : ""}${attrs ? `{${attrs}}` : ""}`;
}

function plainText(node: RootContent): string {
  if ("value" in node) return node.value;
  if ("children" in node) return node.children.map(plainText).join("");
  return "";
}

function lineRange(position: Position | undefined, edge: "start" | "end"): Position | undefined {
  if (!position) return undefined;
  const line = position[edge].line;
  return {
    start: edge === "start" ? position.start : { line, column: 1 },
    end: edge === "end" ? position.end : { line, column: Number.MAX_SAFE_INTEGER },
  };
}

function text(value: string, position?: Position): Text {
  return position ? { type: "text", value, position } : { type: "text", value };
}

function paragraph(value: string, position?: Position): Paragraph {
  const node: Paragraph = { type: "paragraph", children: [text(value, position)] };
  if (position) node.position = position;
  return node;
}
