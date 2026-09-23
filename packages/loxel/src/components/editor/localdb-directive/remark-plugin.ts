import { $remark } from "@milkdown/kit/utils";
import type { Html, Paragraph, Root, RootContent } from "mdast";
import type { ContainerDirective, Directives } from "mdast-util-directive";
import { directiveFromMarkdown } from "mdast-util-directive";
import { directive } from "micromark-extension-directive";
import type { Plugin } from "unified";
import type { Position } from "unist";
import { SKIP, visit } from "unist-util-visit";

/** mdast node produced for `:::localdb` containers, consumed by localDbBlockSchema. */
export interface LocalDbBlockNode {
  type: "localdb-block";
  /** Verbatim inner source of the fence (without the fence lines), when the source was available. */
  raw?: string;
  /**
   * False when the fence had no closing `:::` of its own — either swallowed to EOF, or nested in
   * another 3-colon container whose closing fence micromark attributes to the ancestor. The
   * serializer then omits the closing fence so a round-trip does not manufacture a new one.
   */
  closed?: boolean;
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
 * - No serializer extension is installed: localDbBlockSchema writes its block as verbatim text,
 *   and remark-directive's `:` escaping rules only matter when text directives are parsed.
 */
export const remarkLocalDbDirective: Plugin<[], Root> = function remarkLocalDbDirective() {
  const data = this.data();
  const micromarkExtensions = data.micromarkExtensions ?? (data.micromarkExtensions = []);
  const fromMarkdownExtensions = data.fromMarkdownExtensions ?? (data.fromMarkdownExtensions = []);

  const { flow } = directive();
  micromarkExtensions.push({ flow });
  fromMarkdownExtensions.push(directiveFromMarkdown());

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

function isDirective(node: { type: string }): node is Directives {
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

  const inner = lines.slice(1).map(containerPrefixStripper(node, source));
  // A last line of `:::` is taken as the closing fence. For an unclosed fence swallowed to EOF
  // whose final content line is literally `:::` this drops that line — accepted as ambiguous.
  const closed = inner.length > 0 && CLOSING_FENCE.test(inner[inner.length - 1] ?? "");
  // An unclosed fence's end offset sits after the final newline, leaving a trailing empty line.
  const body = closed || inner[inner.length - 1] !== "" ? inner : inner.slice(0, -1);
  block.raw = (closed ? body.slice(0, -1) : body).join("\n");
  block.closed = closed;
  return block;
}

/**
 * Continuation lines of a directive carry the enclosing container's prefix (`> ` in a block
 * quote, indentation in a list item), while the opening fence line does not because the node's
 * start offset points at the first colon. Returns a function that strips that prefix, derived
 * from whatever precedes the opening fence on its own source line converted to its continuation
 * form: block-quote markers are kept, list markers become indentation of the same width.
 */
function containerPrefixStripper(
  node: Directives,
  source: string | null,
): (line: string) => string {
  const start = node.position?.start.offset;
  if (source === null || start === undefined) return (line) => line;
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const opening = source.slice(lineStart, start);
  if (!opening) return (line) => line;
  const prefix = opening.replace(/[-*+]|\d+[.)]/g, (marker) => " ".repeat(marker.length));
  const blankPrefix = prefix.trimEnd();
  return (line) => {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
    // Blank block-quote lines are a bare `>` without the trailing space.
    if (blankPrefix && line.startsWith(blankPrefix)) return line.slice(blankPrefix.length);
    // Lazy continuation with less indentation than the marker width.
    if (/^\s*$/.test(line.slice(0, prefix.length))) return line.slice(prefix.length);
    return line;
  };
}

/** Replaces a non-localdb directive with plain nodes that reproduce its source. */
function unwrapDirective(node: Directives, source: string | null): RootContent[] {
  if (node.type === "textDirective") {
    return [verbatim(sourceText(node, source) ?? reconstructOpening(node), node.position)];
  }
  if (node.type === "leafDirective") {
    return [paragraph(sourceText(node, source) ?? reconstructOpening(node), node.position)];
  }

  const lines = sourceLines(node, source);
  const opening = lines?.[0] ?? reconstructOpening(node);
  const lastLine = lines !== null && lines.length > 1 ? lines[lines.length - 1] : undefined;
  const closing =
    lines === null
      ? ":::"
      : lastLine === undefined
        ? undefined
        : containerPrefixStripper(node, source)(lastLine);
  const body = node.children.filter((child) => !isDirectiveLabel(child));

  const out: RootContent[] = [paragraph(opening, lineRange(node.position, "start")), ...body];
  if (closing !== undefined && CLOSING_FENCE.test(closing)) {
    // The closing fence sits at the same container column as the opening one.
    const column = node.position?.start.column ?? 1;
    out.push(paragraph(closing.trim(), lineRange(node.position, "end", column)));
  }
  return out;
}

function isDirectiveLabel(node: RootContent): boolean {
  return node.type === "paragraph" && node.data?.directiveLabel === true;
}

function sourceText(node: Directives, source: string | null): string | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (source === null || start === undefined || end === undefined) return null;
  return source.slice(start, end);
}

function sourceLines(node: Directives, source: string | null): string[] | null {
  const raw = sourceText(node, source);
  return raw === null ? null : raw.split(/\r?\n/);
}

/** Rebuilds `:name[label]{attrs}` when the source text is unavailable. */
function reconstructOpening(node: Directives): string {
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

function lineRange(
  position: Position | undefined,
  edge: "start" | "end",
  column = 1,
): Position | undefined {
  if (!position) return undefined;
  const line = position[edge].line;
  return {
    start: edge === "start" ? position.start : { line, column },
    end: edge === "end" ? position.end : { line, column: Number.MAX_SAFE_INTEGER },
  };
}

/**
 * Inline `html` node: mdast-util-to-markdown writes it unescaped (a `text` node would turn
 * `:::note[Title]` into `:::note\[Title]`, breaking the directive for other tools) and Milkdown
 * renders it as a span showing the value.
 */
function verbatim(value: string, position?: Position): Html {
  return position ? { type: "html", value, position } : { type: "html", value };
}

function paragraph(value: string, position?: Position): Paragraph {
  const node: Paragraph = { type: "paragraph", children: [verbatim(value, position)] };
  if (position) node.position = position;
  return node;
}
