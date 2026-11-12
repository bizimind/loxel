const SENTINEL = "#010203";

/** A 1x1 canvas for `toHexColor`, created on first use; null where 2D canvas is unavailable. */
let colorContext: CanvasRenderingContext2D | null | undefined;

/**
 * Resolve any CSS color (hex, rgb(), oklch(), color-mix(), ...) to `#rrggbb`, or `#rrggbbaa` when
 * translucent: the form Monaco parses and color inputs edit. Returns `raw` where there is no canvas
 * or it cannot parse `raw`.
 */
export function toHexColor(raw: string): string {
  if (/^#[\da-f]{3,8}$/i.test(raw)) return raw;
  if (colorContext === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    colorContext = canvas.getContext("2d", { willReadFrequently: true });
  }
  const ctx = colorContext;
  if (!ctx) return raw;
  ctx.clearRect(0, 0, 1, 1);
  // The canvas ignores a color it cannot parse and keeps the last one; start from a sentinel to
  // tell that apart from a color that happens to equal the last.
  ctx.fillStyle = SENTINEL;
  ctx.fillStyle = raw;
  if (ctx.fillStyle === SENTINEL && raw.trim().toLowerCase() !== SENTINEL) return raw;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 255] = ctx.getImageData(0, 0, 1, 1).data;
  const hex = [r, g, b, ...(a === 255 ? [] : [a])].map((c) => c.toString(16).padStart(2, "0"));
  return `#${hex.join("")}`;
}
