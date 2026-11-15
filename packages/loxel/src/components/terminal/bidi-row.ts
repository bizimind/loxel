/**
 * Display order for terminal rows holding right-to-left text (Hebrew, Arabic, ...).
 *
 * The buffer keeps characters in logical order, as programs write them; this computes the order to
 * draw a row's cells in, per the Unicode Bidirectional Algorithm (UAX #9) with a left-to-right base
 * direction, plus the brackets to mirror inside right-to-left runs. The buffer itself is never
 * changed, so copy, search and the server's emulator all keep seeing logical text.
 *
 * Box-drawing characters split a row into pieces that are ordered independently, so the cells of a
 * table drawn with them never trade places: a run of right-to-left text only reorders within its
 * own cell.
 *
 * Each cell is classified by its base character. Explicit formatting characters (RLM, RLO, RLI, ...)
 * are zero-width, so xterm stores them with the previous cell and they take no part in ordering.
 */

import type { IBuffer, IBufferCell, IBufferLine } from "@xterm/xterm";
import bidiFactory, { type BidiCharTypeName } from "bidi-js";

const bidi = bidiFactory();

/** How one row is drawn: what `WebglAddon.setRowTransform` takes (see webgl-renderer.ts). */
export interface RowTransform {
  /** For each visual column, the logical column whose cell is drawn there (a permutation). */
  readonly visualToLogical: readonly number[];
  /** Replacement characters by logical column: mirrored brackets in right-to-left runs. */
  readonly mirrored: ReadonlyMap<number, string>;
}

/** Characters of right-to-left scripts and Arabic digits: a row without any is drawn as is. */
const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

/**
 * Transforms of rows with right-to-left text, by row text and width. A row's text (empty cells as spaces) fixes its cells and their
 * widths, so it fixes the transform too; scrolling and redraws mostly revisit rows already seen.
 */
const cache = new Map<string, RowTransform>();
const CACHE_LIMIT = 1000;

/** U+2500-U+257F, the box-drawing block tables are drawn with. */
const isBoxDrawing = (code: number) => code >= 0x2500 && code <= 0x257f;

/**
 * bidi-js classifies UTF-16 code units, so a character outside the BMP is fed to it as a BMP
 * stand-in of the same bidi type.
 */
const BMP_STAND_IN: Partial<Record<BidiCharTypeName, string>> = {
  L: "a",
  R: "\u05D0",
  AL: "\u0627",
  EN: "0",
  AN: "\u0660",
  NSM: "\u0300",
  BN: "\u00AD",
  WS: " ",
};
const NEUTRAL_STAND_IN = "\uFFFC";

/** One character on screen: a cell, or a wide character with the spacer cell after it. */
interface Glyph {
  /** The column the glyph starts at, where its cell holds the characters. */
  start: number;
  columns: number[];
  /** The cell's characters, "" for an empty cell. */
  chars: string;
}

function readGlyphs(line: IBufferLine, cols: number): Glyph[] {
  const glyphs: Glyph[] = [];
  let cell: IBufferCell | undefined;
  for (let x = 0; x < cols; x++) {
    cell = line.getCell(x, cell);
    const previous = glyphs.at(-1);
    if (cell?.getWidth() === 0 && previous) {
      previous.columns.push(x);
      continue;
    }
    glyphs.push({ start: x, columns: [x], chars: cell?.getChars() ?? "" });
  }
  return glyphs;
}

/** One UTF-16 unit with the bidi type of the glyph's base character. */
function classChar(chars: string): string {
  const code = chars.codePointAt(0);
  if (code === undefined) return " ";
  if (code <= 0xffff) return String.fromCharCode(code);
  return BMP_STAND_IN[bidi.getBidiCharTypeName(String.fromCodePoint(code))] ?? NEUTRAL_STAND_IN;
}

/**
 * Orders the glyphs of one piece of a row (between box-drawing characters) for display, recording
 * the mirrored characters by logical column.
 */
function orderPiece(glyphs: Glyph[], mirrored: Map<number, string>): Glyph[] {
  if (!glyphs.some((g) => RTL_CHAR.test(g.chars))) return glyphs;
  // One UTF-16 unit per glyph, so string indices are glyph indices. The piece is its own paragraph,
  // so bidi-js resets whitespace at its end (rule L1) like at the end of a line.
  const text = glyphs.map((g) => classChar(g.chars)).join("");
  const embedding = bidi.getEmbeddingLevels(text, "ltr");

  glyphs.forEach((glyph, i) => {
    const mirror =
      (embedding.levels[i] ?? 0) % 2 === 1 ? bidi.getMirroredCharacter(glyph.chars) : null;
    if (mirror) mirrored.set(glyph.start, mirror);
  });

  const order = [...glyphs];
  for (const [start = 0, end = 0] of bidi.getReorderSegments(text, embedding)) {
    order.splice(start, end - start + 1, ...order.slice(start, end + 1).toReversed());
  }
  return order;
}

/**
 * The display order of row `row` of `buffer` (an index into the whole buffer, scrollback
 * included), or undefined when the row holds no right-to-left text and is drawn as is.
 */
export function computeRowTransform(
  buffer: IBuffer,
  row: number,
  cols: number,
): RowTransform | undefined {
  const line = buffer.getLine(row);
  if (!line) return undefined;
  const text = line.translateToString(false, 0, cols);
  if (!RTL_CHAR.test(text)) return undefined;
  const key = `${cols}:${text}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const transform = orderRow(line, cols);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value ?? "");
  cache.set(key, transform);
  return transform;
}

function orderRow(line: IBufferLine, cols: number): RowTransform {
  const mirrored = new Map<number, string>();
  const visualToLogical: number[] = [];
  let piece: Glyph[] = [];
  const flush = () => {
    for (const glyph of orderPiece(piece, mirrored)) visualToLogical.push(...glyph.columns);
    piece = [];
  };
  for (const glyph of readGlyphs(line, cols)) {
    if (!isBoxDrawing(glyph.chars.codePointAt(0) ?? 0)) {
      piece.push(glyph);
      continue;
    }
    flush();
    visualToLogical.push(...glyph.columns);
  }
  flush();
  return { visualToLogical, mirrored };
}
