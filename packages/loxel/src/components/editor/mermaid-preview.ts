/**
 * Renders ```mermaid fenced code blocks as diagrams in Crepe's code block preview panel.
 *
 * The preview is view-only: it never touches the code block's text, so the markdown source (and
 * the source-preserving save) is unaffected. Mermaid is large, so it is imported on the first
 * mermaid block and cached. Repositories can be untrusted, so it runs with
 * `securityLevel: "strict"` (labels escaped, no click handlers or scripts) and the panel
 * sanitizes the SVG again before inserting it.
 */
import type { Mermaid, MermaidConfig } from "mermaid";

import type { PreviewValue, RenderPreview } from "@/components/editor/code-block-preview";
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
    return { className, id, svg };
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

/** Error text goes in through `textContent` so diagram source echoed in it is never parsed as HTML. */
function errorPreview(error: unknown): HTMLElement {
  const el = document.createElement("div");
  el.className = "loxel-mermaid-error";
  el.textContent = `Mermaid error: ${errorMessage(error)}`;
  return el;
}

async function renderDiagram(source: string): Promise<PreviewValue> {
  let rendered: RenderedSvg[];
  try {
    rendered = await renderVariants(source);
  } catch (error) {
    return errorPreview(error);
  }
  const variants = rendered.map(
    ({ className, id, svg }) => `<div class="${className}">${withFreshId(id, svg)}</div>`,
  );
  return `<div class="loxel-mermaid">${variants.join("")}</div>`;
}

/**
 * Preview for ```mermaid blocks, rendered asynchronously. An emptied block clears its preview
 * through the same queue, so a render still in flight cannot land after it. Crepe gives the hook
 * no block identity, so a block switched to another language within a pending render can still
 * receive that render; its next edit replaces it.
 */
export const renderMermaidPreview: RenderPreview = (_language, content, applyPreview) => {
  const job = content.trim() === "" ? () => Promise.resolve(null) : () => renderDiagram(content);
  void enqueue(job).then(applyPreview);
  return undefined;
};
