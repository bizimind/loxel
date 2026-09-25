/**
 * Source-preserving markdown writeback for the rich editor.
 *
 * The editor holds a ProseMirror document, not text: loading parses markdown into a tree and
 * saving serializes the whole tree back. Serialization is canonical (`*` bullets become `-`,
 * setext headings become ATX, blank-line runs collapse, ...), so any edit would otherwise
 * rewrite every block of the file, including ones the user never touched.
 *
 * This module reconciles the canonical output against the last known source text, block by
 * block, much like a keyed list diff: both texts are split into top-level blocks, the canonical
 * form of each source block is compared with the canonical blocks of the current document, and
 * every block whose canonical form is unchanged is emitted as its original source bytes. Only
 * blocks that actually changed (or were added) use the serializer's output. The gap between two
 * preserved blocks that were adjacent in the source (blank lines, link reference definitions) is
 * kept verbatim as well.
 *
 * Blocks are matched by serialized form rather than by node identity: Milkdown plugins rewrite
 * node attributes after load (heading ids, list labels), and undo or programmatic replaces
 * create new node objects for unchanged content, so identity would report false changes.
 *
 * The result is always validated: loading it and serializing it back must reproduce the
 * canonical output exactly. Anything that would change meaning (for example two preserved lists
 * becoming adjacent and merging) falls back to the canonical output, so preservation can only
 * ever be skipped, never produce a different document.
 *
 * Cost: a source that is already in canonical form (anything the editor or a formatter wrote)
 * needs no reconciliation and costs nothing extra. Otherwise each changed document costs one
 * block split and one validation round trip on top of the serializer, memoized per document.
 */

import { diffArrays } from "diff";

/** Half-open character range of one top-level block within a markdown string. */
export interface BlockRange {
  start: number;
  end: number;
}

/**
 * The editor's markdown pipeline, injected so the algorithm stays independent of Milkdown.
 * Canonical strings passed to and returned from this module must be normalized the same way
 * (the editor collapses trailing newlines), so equal documents compare equal as strings.
 */
export interface MarkdownBlockCodec {
  /**
   * Top-level block ranges of `markdown`, as parsed by the same remark pipeline the editor
   * uses, or null when any top-level block has no source position.
   */
  blockRanges: (markdown: string) => BlockRange[] | null;
  /** Serializer form of `markdown`: serialize(parse(markdown)). May throw on unparseable input. */
  canonicalize: (markdown: string) => string;
}

/** The source text the editor content was last loaded from, split into blocks. */
export interface SourceBaseline {
  source: string;
  blocks: BlockRange[];
  /** Serializer form of each source block, index-aligned with `blocks`. */
  canonicalBlocks: string[];
  /** Serializer form of the whole source. */
  canonical: string;
}

/**
 * Split `source` into blocks and record each block's serializer form. Returns null when the
 * source and its serializer form do not split into the same number of top-level blocks, in
 * which case blocks cannot be paired and preservation is disabled for this source.
 */
export function createSourceBaseline(
  source: string,
  codec: MarkdownBlockCodec,
): SourceBaseline | null {
  const blocks = codec.blockRanges(source);
  if (!blocks) return null;
  const canonical = codec.canonicalize(source);
  const canonicalRanges = codec.blockRanges(canonical);
  if (!canonicalRanges || canonicalRanges.length !== blocks.length) return null;
  return {
    source,
    blocks,
    canonicalBlocks: canonicalRanges.map((r) => canonical.slice(r.start, r.end)),
    canonical,
  };
}

/** Last input and output per baseline — the same document is serialized several times per edit. */
const memo = new WeakMap<SourceBaseline, { canonical: string; output: string }>();

/**
 * Rewrite `canonical` (the serializer output of the current document) so that every block that
 * is unchanged relative to `baseline` keeps its original source bytes. Returns `canonical`
 * itself when there is no baseline, nothing can be preserved, or the preserved text would not
 * parse to the same document.
 */
export function preserveSource(
  canonical: string,
  baseline: SourceBaseline | null,
  codec: MarkdownBlockCodec,
): string {
  // A canonical source has nothing to preserve: unchanged blocks already serialize to their bytes.
  if (!baseline || baseline.source === baseline.canonical) return canonical;
  // Nothing changed since the source was loaded; canonicalize(source) === canonical by construction.
  if (canonical === baseline.canonical) return baseline.source;
  const cached = memo.get(baseline);
  if (cached?.canonical === canonical) return cached.output;
  const output = computePreserved(canonical, baseline, codec);
  memo.set(baseline, { canonical, output });
  return output;
}

function computePreserved(
  canonical: string,
  baseline: SourceBaseline,
  codec: MarkdownBlockCodec,
): string {
  const ranges = codec.blockRanges(canonical);
  if (!ranges || ranges.length === 0 || baseline.blocks.length === 0) return canonical;

  const current = ranges.map((r) => canonical.slice(r.start, r.end));
  const match = alignBlocks(baseline.canonicalBlocks, current);
  if (!match.some((m) => m >= 0)) return canonical;
  const origin = sourceOrigins(match, baseline.blocks.length);

  const { source, blocks } = baseline;
  const lastSource = blocks.length - 1;
  const last = ranges.length - 1;
  let output = "";

  for (let j = 0; j <= last; j++) {
    const o = origin[j]!;
    const prev = j > 0 ? origin[j - 1]! : -1;
    const range = ranges[j]!;

    // Separators come from the source when both neighbours sit at adjacent source positions,
    // including around a block edited in place, so blank-line runs and link reference
    // definitions next to an edit survive.
    if (j === 0) {
      output += o === 0 ? source.slice(0, blocks[0]!.start) : canonical.slice(0, range.start);
    } else if (prev >= 0 && o === prev + 1) {
      output += source.slice(blocks[prev]!.end, blocks[o]!.start);
    } else {
      output += canonical.slice(ranges[j - 1]!.end, range.start);
    }

    // Block content comes from the source only when the block is unchanged.
    const m = match[j]!;
    output +=
      m >= 0
        ? source.slice(blocks[m]!.start, blocks[m]!.end)
        : canonical.slice(range.start, range.end);
  }

  output +=
    origin[last] === lastSource
      ? source.slice(blocks[lastSource]!.end)
      : canonical.slice(ranges[last]!.end);

  return validated(output, canonical, codec);
}

/**
 * Source position of each current block: its match for unchanged blocks, and for a run of
 * changed blocks that replaces exactly as many source blocks between the same two matches
 * (blocks edited in place), the position of the source block it replaced. -1 otherwise.
 */
function sourceOrigins(match: readonly number[], sourceCount: number): number[] {
  const origin = [...match];
  let j = 0;
  while (j < match.length) {
    if (match[j]! >= 0) {
      j++;
      continue;
    }
    const runStart = j;
    while (j < match.length && match[j]! < 0) j++;
    const before = runStart > 0 ? match[runStart - 1]! : -1;
    const after = j < match.length ? match[j]! : sourceCount;
    if (after - before - 1 === j - runStart) {
      for (let k = runStart; k < j; k++) origin[k] = before + 1 + (k - runStart);
    }
  }
  return origin;
}

/** Keep `output` only if loading it back yields exactly the document `canonical` describes. */
function validated(output: string, canonical: string, codec: MarkdownBlockCodec): string {
  if (output === canonical) return canonical;
  try {
    return codec.canonicalize(output) === canonical ? output : canonical;
  } catch {
    return canonical;
  }
}

/**
 * Longest-common-subsequence alignment of two block lists. Returns, for each entry of `next`,
 * the index of the matching entry in `prev`, or -1 when the block is new or changed. Matches are
 * strictly increasing, so preserved blocks keep their relative order.
 */
export function alignBlocks(prev: readonly string[], next: readonly string[]): number[] {
  const match = Array.from({ length: next.length }, () => -1);
  let p = 0;
  let n = 0;
  for (const change of diffArrays([...prev], [...next])) {
    const count = change.count ?? change.value.length;
    if (change.removed) {
      p += count;
    } else if (change.added) {
      n += count;
    } else {
      for (let k = 0; k < count; k++) match[n++] = p++;
    }
  }
  return match;
}

/**
 * Top-level block ranges of a parsed mdast tree. Returns null when the tree is not a root with
 * positioned children (transforms may synthesize nodes without positions).
 */
export function topLevelBlockRanges(tree: unknown): BlockRange[] | null {
  if (!isRecord(tree) || !Array.isArray(tree.children)) return null;
  const ranges: BlockRange[] = [];
  for (const child of tree.children) {
    const range = positionRange(child);
    if (!range) return null;
    ranges.push(range);
  }
  return ranges;
}

function positionRange(node: unknown): BlockRange | null {
  if (!isRecord(node) || !isRecord(node.position)) return null;
  const { start, end } = node.position;
  if (!isRecord(start) || !isRecord(end)) return null;
  if (typeof start.offset !== "number" || typeof end.offset !== "number") return null;
  return { start: start.offset, end: end.offset };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
