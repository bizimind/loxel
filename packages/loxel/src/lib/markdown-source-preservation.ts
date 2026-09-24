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
 * The result is always validated: it must parse to the same document as the canonical output.
 * Anything that would change meaning (for example two preserved lists becoming adjacent and
 * merging) falls back to the canonical output, so preservation can only ever be skipped, never
 * produce a different document.
 */

/** Half-open character range of one top-level block within a markdown string. */
export interface BlockRange {
  start: number;
  end: number;
}

/** The editor's markdown pipeline, injected so the algorithm stays independent of Milkdown. */
export interface MarkdownBlockCodec {
  /**
   * Top-level block ranges of `markdown`, as parsed by the same remark pipeline the editor
   * uses, or null when any top-level block has no source position.
   */
  blockRanges: (markdown: string) => BlockRange[] | null;
  /** Serializer form of `markdown`: serialize(parse(markdown)). May throw on unparseable input. */
  canonicalize: (markdown: string) => string;
  /** Whether two markdown strings parse to the same editor document. */
  equivalent: (a: string, b: string) => boolean;
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

/** Above this many cells, the alignment of the changed middle section is skipped. */
const MAX_ALIGNMENT_CELLS = 1_000_000;

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
  if (!baseline) return canonical;
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
  if (canonical === baseline.canonical) {
    // Nothing changed since the source was loaded.
    return validated(baseline.source, canonical, codec);
  }

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

function validated(output: string, canonical: string, codec: MarkdownBlockCodec): string {
  if (output === canonical) return canonical;
  return codec.equivalent(output, canonical) ? output : canonical;
}

/**
 * Longest-common-subsequence alignment of two block lists. Returns, for each entry of `next`,
 * the index of the matching entry in `prev`, or -1 when the block is new or changed. Matches are
 * strictly increasing, so preserved blocks keep their relative order.
 */
export function alignBlocks(prev: readonly string[], next: readonly string[]): number[] {
  const match = Array.from({ length: next.length }, () => -1);

  // Most edits touch one region: match the common prefix and suffix directly.
  let head = 0;
  while (head < prev.length && head < next.length && prev[head] === next[head]) {
    match[head] = head;
    head++;
  }
  let tail = 0;
  while (
    tail < prev.length - head &&
    tail < next.length - head &&
    prev[prev.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    match[next.length - 1 - tail] = prev.length - 1 - tail;
    tail++;
  }

  const rows = prev.length - head - tail;
  const cols = next.length - head - tail;
  if (rows === 0 || cols === 0 || rows * cols > MAX_ALIGNMENT_CELLS) return match;

  // lcs[i][j] = LCS length of prev[head + i ..] and next[head + j ..] within the middle section.
  const width = cols + 1;
  const lcs = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lcs[i * width + j] =
        prev[head + i] === next[head + j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (prev[head + i] === next[head + j]) {
      match[head + j] = head + i;
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      i++;
    } else {
      j++;
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
