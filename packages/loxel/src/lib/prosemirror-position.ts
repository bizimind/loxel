/**
 * Convert a raw-file line:column into a ProseMirror document position.
 *
 * Uses remark to parse the markdown into an mdast tree (which preserves exact
 * source positions on every node). Collects all mdast leaf nodes that produce
 * ProseMirror text (text, inlineCode, code) in document order, finds the one
 * at the target line:column, and then walks ProseMirror's text nodes in the
 * same order to find the corresponding position. This ordinal-matching approach
 * correctly handles repeated text and ignores mdast nodes that have no PM
 * representation (HTML, comments, images, link URLs).
 */
import type { Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Node as UnistNode } from "unist";

import { splitFrontmatter } from "./frontmatter";

const remarkProcessor = unified().use(remarkParse).use(remarkGfm);

/** mdast node types that produce visible text in ProseMirror. */
const PM_TEXT_TYPES = new Set(["text", "inlineCode", "code"]);

interface TextLeaf {
  node: UnistNode;
  value: string;
}

function isStringValue(node: UnistNode): node is UnistNode & { value: string } {
  return "value" in node && typeof node.value === "string";
}

function hasChildren(node: UnistNode): node is UnistNode & { children: UnistNode[] } {
  return "children" in node && Array.isArray(node.children);
}

/**
 * Map a 1-based line:column in a raw markdown file to a ProseMirror doc position.
 * Returns null if the target line falls within frontmatter (handled by a separate editor).
 */
export function rawLineToProsePosition(
  doc: ProseMirrorNode,
  rawLine: number,
  rawColumn: number,
  rawContent: string,
): number | null {
  const { body } = splitFrontmatter(rawContent);

  // Count how many lines the frontmatter prefix consumes
  const prefixLength = rawContent.length - body.length;
  const frontmatterLineCount =
    prefixLength > 0 ? rawContent.slice(0, prefixLength).split("\n").length - 1 : 0;

  const bodyLine = rawLine - frontmatterLineCount;
  if (bodyLine < 1) return null; // target is within frontmatter

  // Parse the markdown body to get the AST with source positions.
  // Navigation failure is recoverable — fall back to proportional estimate.
  let tree;
  try {
    tree = remarkProcessor.parse(body);
  } catch {
    return proportionalFallback(bodyLine, body, doc.content.size);
  }

  // Collect all mdast leaf nodes that produce PM text, in document order
  const mdastLeaves: TextLeaf[] = [];
  collectTextLeaves(tree, mdastLeaves);

  // Find which mdast leaf contains (bodyLine, rawColumn) and compute offset within it
  let targetIndex = -1;
  let offsetInLeaf = 0;

  for (let i = 0; i < mdastLeaves.length; i++) {
    const { node } = mdastLeaves[i]!;
    if (!node.position) continue;
    const { start, end } = node.position;

    const afterStart =
      bodyLine > start.line || (bodyLine === start.line && rawColumn >= start.column);
    const beforeEnd = bodyLine < end.line || (bodyLine === end.line && rawColumn <= end.column);

    if (afterStart && beforeEnd) {
      targetIndex = i;
      // For multi-line nodes (code blocks), compute offset accounting for internal newlines.
      // Remark's code node position spans the fence lines, but node.value only contains
      // the inner content — subtract 1 for the opening fence line.
      const fenceOffset = node.type === "code" ? 1 : 0;
      const adjustedLineWithin = bodyLine - start.line - fenceOffset;
      if (adjustedLineWithin <= 0) {
        offsetInLeaf = rawColumn - start.column;
      } else {
        const value = mdastLeaves[i]!.value;
        const lines = value.split("\n");
        let offset = 0;
        for (let l = 0; l < adjustedLineWithin && l < lines.length; l++) {
          offset += lines[l]!.length + 1; // +1 for \n
        }
        offsetInLeaf = offset + Math.max(0, rawColumn - 1);
      }
      break;
    }
  }

  // If the target position falls inside non-rendered syntax (e.g. link URL, image alt/URL),
  // no text leaf matches. Find the deepest mdast node at that position and navigate to its
  // first rendered text descendant instead.
  if (targetIndex === -1) {
    const ancestor = findDeepestNodeAt(tree, bodyLine, rawColumn);
    if (ancestor) {
      const firstLeaf = findFirstTextLeaf(ancestor);
      if (firstLeaf) {
        targetIndex = mdastLeaves.findIndex((l) => l.node === firstLeaf);
        offsetInLeaf = 0;
      }
    }
  }

  if (targetIndex === -1) {
    return proportionalFallback(bodyLine, body, doc.content.size);
  }

  // Collect PM text nodes in document order (same order as mdast leaves)
  const pmLeaves: Array<{ pos: number; text: string }> = [];
  doc.descendants((node, pos) => {
    if (node.isText) {
      pmLeaves.push({ pos, text: node.text! });
    }
    return true;
  });

  // Match by ordinal: the Nth mdast text leaf corresponds to the Nth PM text node
  if (targetIndex < pmLeaves.length) {
    const pmLeaf = pmLeaves[targetIndex]!;
    const clampedOffset = Math.min(Math.max(0, offsetInLeaf), pmLeaf.text.length);
    return pmLeaf.pos + clampedOffset;
  }

  return proportionalFallback(bodyLine, body, doc.content.size);
}

/** Find the deepest mdast node whose source range contains (line, column). */
function findDeepestNodeAt(node: UnistNode, line: number, column: number): UnistNode | null {
  if (!node.position) return null;
  const { start, end } = node.position;
  const afterStart = line > start.line || (line === start.line && column >= start.column);
  const beforeEnd = line < end.line || (line === end.line && column <= end.column);
  if (!afterStart || !beforeEnd) return null;

  if (hasChildren(node)) {
    for (const child of node.children) {
      const deeper = findDeepestNodeAt(child, line, column);
      if (deeper) return deeper;
    }
  }
  return node;
}

/** Find the first text/inlineCode/code leaf within an mdast subtree. */
function findFirstTextLeaf(node: UnistNode): UnistNode | null {
  if (PM_TEXT_TYPES.has(node.type) && isStringValue(node)) return node;
  if (hasChildren(node)) {
    for (const child of node.children) {
      const found = findFirstTextLeaf(child);
      if (found) return found;
    }
  }
  return null;
}

/** Recursively collect mdast leaf nodes that produce PM text, in document order. */
function collectTextLeaves(node: UnistNode, out: TextLeaf[]): void {
  if (PM_TEXT_TYPES.has(node.type) && isStringValue(node)) {
    out.push({ node, value: node.value });
    return;
  }
  if (hasChildren(node)) {
    for (const child of node.children) {
      collectTextLeaves(child, out);
    }
  }
}

function proportionalFallback(bodyLine: number, body: string, docSize: number): number {
  const totalLines = body.split("\n").length;
  const fraction = (bodyLine - 1) / Math.max(1, totalLines - 1);
  return Math.min(Math.round(fraction * docSize), docSize);
}
