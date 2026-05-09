export const STROKE_COLOR = "#1e1e1e";
export const BACKGROUND_COLOR = "transparent";
export const FILL_STYLE = "solid";
export const STROKE_WIDTH = 2;
export const STROKE_STYLE = "solid";
export const ROUGHNESS = 1;
export const OPACITY = 100;
export const FONT_SIZE = 20;
export const LINE_HEIGHT = 1.25;

export const FONT_FAMILIES = {
  hand: 5, // Excalifont
  normal: 2, // Helvetica
  code: 3, // Cascadia
} as const;

export type FontFamilyName = keyof typeof FONT_FAMILIES;

export const RECT_DEFAULTS = { width: 200, height: 100 };
export const ELLIPSE_DEFAULTS = { width: 200, height: 200 };
export const DIAMOND_DEFAULTS = { width: 160, height: 160 };
export const FRAME_DEFAULTS = { width: 800, height: 600 };
export const LINE_DEFAULTS = {
  points: [
    [0, 0],
    [200, 0],
  ] as [number, number][],
};

export const ROUNDNESS_PROPORTIONAL = { type: 3 as const };
export const ROUNDNESS_ADAPTIVE = { type: 2 as const };
