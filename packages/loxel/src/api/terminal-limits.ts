/**
 * Bounds for a terminal's size and scrollback, enforced by the renderer's settings and fitting and
 * again by whoever owns the PTY and its emulator. Imports nothing, so the terminal host can use it.
 */

/** Default number of scrollback lines. Shared by client settings and server fallback. */
export const DEFAULT_SCROLLBACK_LINES = 50_000;

/** Bounds for the scrollback setting, enforced on both sides. */
export const MIN_SCROLLBACK_LINES = 1_000;
export const MAX_SCROLLBACK_LINES = 100_000;

/**
 * Bounds for a terminal's size. The server-side emulator allocates its cell grid eagerly, so
 * sizes are clamped there as well as fitted on the client.
 */
export const MIN_TERMINAL_COLS = 2;
export const MAX_TERMINAL_COLS = 1_000;
export const MIN_TERMINAL_ROWS = 1;
export const MAX_TERMINAL_ROWS = 500;

function clampDimension(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function clampTerminalSize(cols: number, rows: number): { cols: number; rows: number } {
  return {
    cols: clampDimension(cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS, 80),
    rows: clampDimension(rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS, 24),
  };
}

export function clampScrollbackLines(lines: number | undefined): number {
  return Math.max(
    MIN_SCROLLBACK_LINES,
    Math.min(MAX_SCROLLBACK_LINES, lines ?? DEFAULT_SCROLLBACK_LINES),
  );
}
