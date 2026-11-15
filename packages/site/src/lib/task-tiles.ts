// The task avatars of Loxel's sidebar, redrawn for the site: a rounded tile in one of the sidebar's
// colors with a small pixel glyph. Each glyph is a 5×5 grid, `#` for a filled pixel.
export const TASK_COLORS = {
  green: "#4a8224",
  olive: "#627a04",
  purple: "#6b62bc",
  orange: "#b3521b",
  teal: "#028293",
  pink: "#b34a62",
  blue: "#3e6fd6",
  emerald: "#02885a",
} as const;

export const TASK_GLYPHS = {
  arch: [".###.", "#####", "##.##", "##.##", "##.##"],
  bars: ["#####", ".....", "##.##", "#...#", "#...#"],
  cross: ["##.##", ".###.", "..#..", ".###.", "##.##"],
  dice: ["##.##", ".....", "..#..", ".....", "##.##"],
  frame: ["##.##", "#...#", ".....", "#.#.#", "##.##"],
  gate: ["#####", "#...#", "#.#.#", "#.#.#", "....."],
  smile: ["#...#", "#...#", ".#.#.", "#####", "....."],
  tee: ["#####", "..#..", "..##.", "..#..", ".#.#."],
} as const satisfies Record<string, readonly string[]>;

export type TaskColor = keyof typeof TASK_COLORS;
export type TaskGlyph = keyof typeof TASK_GLYPHS;
