/**
 * Copy a rendered Mermaid diagram to the clipboard as SVG markup or a 2x PNG. Both take the SVG
 * element on screen, so the copy is the same sanitized, strict-mode output the user sees.
 */
import { showToast } from "@/components/ui/toast";
import { frontendLog } from "@/lib/frontend-logger";

const PNG_SCALE = 2;

export type DiagramCopyFormat = "svg" | "png";

/** The SVG markup at its natural size (mermaid emits `width="100%"` and a max-width style). */
function standaloneMarkup(svg: SVGSVGElement): { markup: string; width: number; height: number } {
  const { width, height } = svg.viewBox.baseVal;
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.removeAttribute("style");
  copy.setAttribute("width", String(width));
  copy.setAttribute("height", String(height));
  return { markup: new XMLSerializer().serializeToString(copy), width, height };
}

async function pngBlob(svg: SVGSVGElement, background: string): Promise<Blob> {
  const { markup, width, height } = standaloneMarkup(svg);
  if (width <= 0 || height <= 0) throw new Error("The diagram has no size");
  // A data: URL, not a blob: URL: Chromium taints the canvas for blob: SVGs with foreignObject.
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * PNG_SCALE);
  canvas.height = Math.ceil(height * PNG_SCALE);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D canvas context");
  // The diagram's colors assume the surface it is shown on, so the PNG keeps that background.
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  if (!blob) throw new Error("Could not encode the PNG");
  return blob;
}

/** Copy `svg` in `format`, with `background` behind a PNG; reports the outcome in a toast. */
export async function copyDiagram(
  svg: SVGSVGElement,
  format: DiagramCopyFormat,
  background: string,
): Promise<void> {
  try {
    if (format === "svg") {
      await navigator.clipboard.writeText(standaloneMarkup(svg).markup);
    } else {
      const blob = await pngBlob(svg, background);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    }
    showToast(`Copied diagram as ${format.toUpperCase()}`, "info");
  } catch (error) {
    frontendLog.child("ui").error("Failed to copy diagram", { error, format });
    showToast(`Could not copy the diagram as ${format.toUpperCase()}`);
  }
}

/** The first opaque background color behind `element`, for a PNG copy. */
export function surfaceColor(element: Element): string {
  for (let el: Element | null = element; el; el = el.parentElement) {
    const color = getComputedStyle(el).backgroundColor;
    if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") return color;
  }
  return "white";
}
