import { describe, expect, test } from "bun:test";

import { Terminal } from "@xterm/headless";

import { computeRowTransform } from "./bidi-row";

const COLS = 40;
const COLUMNS = [...Array.from({ length: COLS }).keys()];

/** A fresh terminal with `text` written on row 0. */
async function terminalWith(text: string): Promise<Terminal> {
  const terminal = new Terminal({ cols: COLS, rows: 2, allowProposedApi: true });
  await new Promise<void>((resolve) => {
    terminal.write(text, resolve);
  });
  return terminal;
}

/** Row 0 as drawn with its transform, and how many characters the transform mirrors. */
async function render(text: string): Promise<{ drawn: string; mirrored: number }> {
  const terminal = await terminalWith(text);
  const buffer = terminal.buffer.active;
  const line = buffer.getLine(0);
  if (!line) throw new Error("row 0 missing");
  const transform = computeRowTransform(buffer, 0, COLS);
  const order = transform ? [...transform.visualToLogical] : COLUMNS;
  expect(order.toSorted((a, b) => a - b)).toEqual(COLUMNS);
  const drawn = order
    .map((x) => transform?.mirrored.get(x) ?? line.getCell(x)?.getChars() ?? "")
    .map((chars) => chars || " ")
    .join("")
    .trimEnd();
  terminal.dispose();
  return { drawn, mirrored: transform?.mirrored.size ?? 0 };
}

describe("computeRowTransform", () => {
  test("leaves rows without right-to-left text alone", async () => {
    const terminal = await terminalWith("plain │ ascii (text)");
    expect(computeRowTransform(terminal.buffer.active, 0, COLS)).toBeUndefined();
    terminal.dispose();
  });

  test("reverses a Hebrew run inside left-to-right text", async () => {
    expect((await render("company (חברה פרטית)")).drawn).toBe("company (תיטרפ הרבח)");
  });

  test("lays out a fully Hebrew row right to left from the left edge", async () => {
    expect((await render("שלום עולם")).drawn).toBe("םלוע םולש");
  });

  test("mirrors brackets inside a right-to-left run", async () => {
    const { drawn, mirrored } = await render("א (ב) ג");
    expect(drawn).toBe("ג (ב) א");
    expect(mirrored).toBe(2);
  });

  test("keeps numbers left to right inside Hebrew", async () => {
    expect((await render("שנת 2026 טובה")).drawn).toBe("הבוט 2026 תנש");
  });

  test("orders each table cell on its own", async () => {
    expect((await render("│ אחד שתיים │ שלוש │")).drawn).toBe("│ םייתש דחא │ שולש │");
  });

  test("gives rows with the same text the same transform", async () => {
    const terminal = await terminalWith("שלום (a)\r\nשלום (a)\r\nשלום (b)");
    const buffer = terminal.buffer.active;
    const first = computeRowTransform(buffer, 0, COLS);
    expect(computeRowTransform(buffer, 1, COLS)).toBe(first);
    expect(computeRowTransform(buffer, 2, COLS)).not.toBe(first);
    terminal.dispose();
  });

  test("keeps a wide character's spacer after it", async () => {
    // The fullwidth "！" is neutral between Hebrew letters, so it moves with them; its spacer cell
    // (drawn blank here) stays to its right.
    expect((await render("א ！ ב")).drawn).toBe("ב ！  א");
  });
});
