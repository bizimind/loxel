/**
 * Renders ```mermaid fenced code blocks as diagrams in Crepe's code block preview panel.
 *
 * The preview is view-only: it never touches the code block's text, so the markdown source (and
 * the source-preserving save) is unaffected. Mermaid is large, so it is imported on the first
 * mermaid block and cached. Repositories can be untrusted, so it runs with
 * `securityLevel: "strict"` (labels escaped, no click handlers or scripts), and its SVG is
 * sanitized again before insertion: by the panel for the preview, here for the full-size viewer.
 *
 * The preview's toolbar, zoom, pan and click-to-open are in mermaid-preview-controls.tsx.
 */
import DOMPurify from "dompurify";
import type { Mermaid, MermaidConfig } from "mermaid";

import type { PreviewValue, RenderPreview } from "@/components/editor/code-block-preview";
import {
  MERMAID_CLASSES,
  mermaidEditButtonHtml,
  mermaidToolbarHtml,
} from "@/components/editor/mermaid-preview-controls";
import { recordMermaidRender } from "@/components/editor/mermaid-render-results";
import type { Dimensions } from "@/components/pan-zoom/pan-zoom";
import { frontendLog } from "@/lib/frontend-logger";

import "@/styles/mermaid-preview.css";

const log = frontendLog.child("ui");

/**
 * The preview panel only re-renders when the block's text or language changes, so each diagram
 * is rendered once per theme and CSS shows the variant matching the editor's `dark` class.
 */
const THEME_VARIANTS = [
  { className: "loxel-mermaid-light", theme: "default" },
  { className: "loxel-mermaid-dark", theme: "dark" },
] as const satisfies readonly { className: string; theme: MermaidConfig["theme"] }[];

let mermaidPromise: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import("mermaid").then(
    (mod) => mod.default,
    (error: unknown) => {
      mermaidPromise = null; // let the next diagram retry the import
      log.error("Failed to load mermaid", { error });
      throw error;
    },
  );
  return mermaidPromise;
}

/**
 * Mermaid keeps global config and renders into a temp node on `document.body`, so renders run
 * one at a time. The FIFO order also means a block's latest text always renders last, so a slow
 * earlier render never overwrites a newer preview.
 */
let renderQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(job);
  renderQueue = run.catch(() => {});
  return run;
}

let idCount = 0;

function nextId(): string {
  idCount += 1;
  return `loxel-mermaid-${idCount}`;
}

/** One theme's SVG and the id mermaid scoped its styles and marker references to. */
interface RenderedSvg {
  className: string;
  id: string;
  svg: string;
  /** The diagram's natural size, from its `viewBox`; null if it has none. */
  size: Dimensions | null;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
let purify: ReturnType<typeof DOMPurify> | null = null;

/** The code block panel's sanitizer config (Crepe's `createSvgAwareSanitizer`). */
function sanitizeSvg(svg: string): string {
  if (!purify) {
    purify = DOMPurify();
    purify.addHook("uponSanitizeElement", (node, data) => {
      if (data.tagName !== "foreignobject") return;
      if (node.parentElement?.namespaceURI !== SVG_NAMESPACE) node.parentNode?.removeChild(node);
    });
  }
  return purify.sanitize(svg, {
    ADD_TAGS: ["foreignObject"],
    ADD_ATTR: ["xmlns"],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
  });
}

/** The width and height of the root `<svg>`'s `viewBox`. */
function viewBoxSize(svg: string): Dimensions | null {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
  const box = /\bviewBox="([^"]*)"/
    .exec(root)?.[1]
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const width = box?.[2];
  const height = box?.[3];
  if (width === undefined || height === undefined || !(width > 0) || !(height > 0)) return null;
  return { width, height };
}

/**
 * Rendered diagrams by source. Code blocks unmount when scrolled off-screen and render their
 * preview again when they come back, so this keeps that from re-running mermaid.
 */
const diagramCache = new Map<string, RenderedSvg[]>();
const DIAGRAM_CACHE_SIZE = 50;

async function renderSvg(
  mermaid: Mermaid,
  source: string,
  { className, theme }: (typeof THEME_VARIANTS)[number],
): Promise<RenderedSvg> {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme,
  });
  const id = nextId();
  try {
    const { svg } = await mermaid.render(id, source);
    return { className, id, svg, size: viewBoxSize(svg) };
  } finally {
    // Mermaid removes its temp container on success but can leave it behind when rendering throws.
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(id)?.remove();
  }
}

async function renderVariants(source: string): Promise<RenderedSvg[]> {
  const cached = diagramCache.get(source);
  if (cached) {
    diagramCache.delete(source); // re-insert as most recently used
    diagramCache.set(source, cached);
    return cached;
  }
  const mermaid = await loadMermaid();
  const rendered: RenderedSvg[] = [];
  for (const variant of THEME_VARIANTS) {
    // oxlint-disable-next-line no-await-in-loop -- mermaid renders must not overlap
    rendered.push(await renderSvg(mermaid, source, variant));
  }
  diagramCache.set(source, rendered);
  if (diagramCache.size > DIAGRAM_CACHE_SIZE) {
    const oldest = diagramCache.keys().next();
    if (!oldest.done) diagramCache.delete(oldest.value);
  }
  return rendered;
}

/** A copy of the SVG under a new id, so two copies of one diagram in the document never share ids. */
function withFreshId(id: string, svg: string): string {
  return svg.replace(new RegExp(`${id}(?!\\d)`, "g"), nextId());
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

/**
 * The error, with an Edit button (static markup) for a block collapsed over it. Error text goes in
 * through `textContent` so diagram source echoed in it is never parsed as HTML.
 */
function errorPreview(error: unknown): HTMLElement {
  const preview = document.createElement("div");
  preview.className = "loxel-mermaid-error-preview";
  preview.innerHTML = mermaidEditButtonHtml();
  const message = document.createElement("div");
  message.className = "loxel-mermaid-error";
  message.textContent = `Mermaid error: ${errorMessage(error)}`;
  preview.append(message);
  return preview;
}

/**
 * The preview: the toolbar, and both theme variants on a canvas inside a clipping viewport. The
 * natural width lets CSS keep the diagram from shrinking below a readable size.
 */
async function renderDiagram(source: string): Promise<PreviewValue> {
  let rendered: RenderedSvg[];
  try {
    rendered = await renderVariants(source);
  } catch (error) {
    recordMermaidRender(source, false);
    return errorPreview(error);
  }
  recordMermaidRender(source, true);
  const variants = rendered.map(
    ({ className, id, svg }) => `<div class="${className}">${withFreshId(id, svg)}</div>`,
  );
  const width = rendered[0]?.size?.width;
  const style = width === undefined ? "" : ` style="--loxel-mermaid-width: ${width}px"`;
  return (
    `<div class="${MERMAID_CLASSES.diagram}"${style}>${mermaidToolbarHtml()}` +
    `<div class="${MERMAID_CLASSES.viewport}" title="Click to open full size, drag to pan, pinch to zoom">` +
    `<div class="${MERMAID_CLASSES.canvas}">${variants.join("")}</div></div></div>`
  );
}

/** A diagram's light and dark SVGs (sanitized, under fresh ids) and its natural size. */
export interface MermaidDiagram {
  light: string;
  dark: string;
  size: Dimensions | null;
}

/** Renders `source` for the full-size viewer; usually a cache hit, as its preview rendered it. */
export async function renderMermaidDiagram(source: string): Promise<MermaidDiagram> {
  const rendered = await enqueue(() => renderVariants(source));
  const svgFor = (className: string) => {
    const variant = rendered.find((r) => r.className === className);
    if (!variant) throw new Error(`Missing the ${className} variant`);
    return sanitizeSvg(withFreshId(variant.id, variant.svg));
  };
  return {
    light: svgFor("loxel-mermaid-light"),
    dark: svgFor("loxel-mermaid-dark"),
    size: rendered[0]?.size ?? null,
  };
}

/**
 * Preview for ```mermaid blocks, rendered asynchronously. An empty block has no preview at once
 * (so no loading placeholder), and also clears it through the same queue, so a render still in
 * flight cannot land after it. Crepe gives the hook no block identity, so a block switched to
 * another language within a pending render can still receive that render; its next edit
 * replaces it.
 */
export const renderMermaidPreview: RenderPreview = (_language, content, applyPreview) => {
  const empty = content.trim() === "";
  void enqueue(empty ? () => Promise.resolve(null) : () => renderDiagram(content)).then(
    applyPreview,
  );
  return empty ? null : undefined;
};
