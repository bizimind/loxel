/**
 * Zoom, pan, copy and open for Mermaid previews in the markdown editor.
 *
 * Crepe inserts previews as sanitized HTML, so a preview carries no listeners: its toolbar is
 * static markup ({@link mermaidToolbarHtml}) and {@link attachMermaidPreviewControls} handles
 * everything by delegation from the editor's container. A preview's zoom and pan live on its
 * canvas element, so they reset whenever the panel re-renders the preview (on every edit of the
 * block). Pinch or Cmd/Ctrl+wheel zooms about the pointer and horizontal wheel or drag pans; a
 * vertical wheel is left to scroll the document. A click without a drag opens the full-size
 * viewer. The zoom geometry is the media viewer's (`pan-zoom.ts`). Edit and Hide show and hide the
 * block's source by moving the caret into and out of it (code-block-source.ts); CSS shows the one
 * that applies.
 */
import type { EditorView } from "@milkdown/kit/prose/view";
import {
  CopyIcon,
  EyeOffIcon,
  Maximize2Icon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  ScanIcon,
} from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";

import { editCodeBlockSource, hideCodeBlockSource } from "@/components/editor/code-block-source";
import {
  copyDiagram,
  type DiagramCopyFormat,
  surfaceColor,
} from "@/components/editor/mermaid-export";
import {
  DRAG_THRESHOLD,
  IDENTITY_VIEW,
  isZoomWheel,
  type PanZoomView,
  type Point,
  type ScaleLimits,
  viewTransform,
  wheelZoomFactor,
  ZOOM_MAX,
  ZOOM_STEP,
  zoomAt,
} from "@/components/pan-zoom/pan-zoom";

const ACTION_ATTR = "data-mermaid-action";
const ACTIONS = [
  "edit",
  "hide",
  "zoom-out",
  "zoom-in",
  "reset",
  "copy-svg",
  "copy-png",
  "open",
] as const;
type Action = (typeof ACTIONS)[number];

/** Class names of the preview's parts, shared with the markup in mermaid-preview.ts. */
export const MERMAID_CLASSES = {
  diagram: "loxel-mermaid",
  viewport: "loxel-mermaid-viewport",
  canvas: "loxel-mermaid-canvas",
} as const;

function ToolbarButton({
  action,
  title,
  children,
}: {
  action: Action;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      {...{ [ACTION_ATTR]: action }}
      title={title}
      className="text-muted-foreground hover:text-foreground hover:bg-muted flex h-6 items-center gap-1 rounded-md px-1.5 transition-colors"
    >
      {children}
    </button>
  );
}

function MermaidToolbar() {
  return (
    <div className="loxel-mermaid-toolbar bg-background/90 border-border flex items-center gap-0.5 rounded-md border p-0.5 font-sans text-[10px] shadow-sm backdrop-blur-sm">
      <ToolbarButton action="edit" title="Edit the diagram's source">
        <PencilIcon className="size-3" />
        Edit
      </ToolbarButton>
      <ToolbarButton action="hide" title="Hide the source">
        <EyeOffIcon className="size-3" />
        Hide
      </ToolbarButton>
      <ToolbarButton action="zoom-out" title="Zoom out">
        <MinusIcon className="size-3" />
      </ToolbarButton>
      <ToolbarButton action="zoom-in" title="Zoom in">
        <PlusIcon className="size-3" />
      </ToolbarButton>
      <ToolbarButton action="reset" title="Reset zoom">
        <ScanIcon className="size-3" />
      </ToolbarButton>
      <ToolbarButton action="copy-svg" title="Copy as SVG">
        <CopyIcon className="size-3" />
        SVG
      </ToolbarButton>
      <ToolbarButton action="copy-png" title="Copy as PNG">
        <CopyIcon className="size-3" />
        PNG
      </ToolbarButton>
      <ToolbarButton action="open" title="Open full size">
        <Maximize2Icon className="size-3" />
        Open
      </ToolbarButton>
    </div>
  );
}

let toolbarHtml: string | null = null;

/** The preview toolbar's static markup. */
export function mermaidToolbarHtml(): string {
  toolbarHtml ??= renderToStaticMarkup(<MermaidToolbar />);
  return toolbarHtml;
}

/** Each preview canvas's current view; a re-rendered preview starts again from none. */
const views = new WeakMap<HTMLElement, PanZoomView>();

interface PreviewParts {
  diagram: HTMLElement;
  viewport: HTMLElement;
  canvas: HTMLElement;
}

function previewParts(target: EventTarget | null): PreviewParts | null {
  if (!(target instanceof Element)) return null;
  const diagram = target.closest<HTMLElement>(`.${MERMAID_CLASSES.diagram}`);
  const viewport = diagram?.querySelector<HTMLElement>(`.${MERMAID_CLASSES.viewport}`);
  const canvas = viewport?.querySelector<HTMLElement>(`.${MERMAID_CLASSES.canvas}`);
  return diagram && viewport && canvas ? { diagram, viewport, canvas } : null;
}

/**
 * The canvas is laid out at the preview's own scale (fitted to the width, but not below a
 * readable size), so zooming out stops where the whole width fits.
 */
function scaleLimits({ viewport, canvas }: PreviewParts): ScaleLimits {
  const width = canvas.scrollWidth;
  return { min: width > 0 ? Math.min(1, viewport.clientWidth / width) : 1, max: ZOOM_MAX };
}

/** Keeps the canvas covering the viewport where it is larger, and inside it where smaller. */
function clampView({ viewport, canvas }: PreviewParts, view: PanZoomView): PanZoomView {
  const clamp = (offset: number, viewportSize: number, contentSize: number) => {
    const slack = viewportSize - contentSize * view.scale;
    return Math.min(Math.max(offset, Math.min(0, slack)), Math.max(0, slack));
  };
  return {
    scale: view.scale,
    x: clamp(view.x, viewport.clientWidth, canvas.scrollWidth),
    y: clamp(view.y, viewport.clientHeight, canvas.scrollHeight),
  };
}

function viewOf(parts: PreviewParts): PanZoomView {
  return views.get(parts.canvas) ?? IDENTITY_VIEW;
}

/** Applies `view` (clamped); returns whether it moved the canvas. */
function setView(parts: PreviewParts, view: PanZoomView): boolean {
  const next = clampView(parts, view);
  const prev = viewOf(parts);
  if (next.x === prev.x && next.y === prev.y && next.scale === prev.scale) return false;
  views.set(parts.canvas, next);
  parts.canvas.style.transform = viewTransform(next);
  return true;
}

function zoom(parts: PreviewParts, factor: number, at: Point): void {
  setView(parts, zoomAt(viewOf(parts), factor, at, scaleLimits(parts)));
}

/** The variant the editor's theme shows (CSS hides the other). */
function visibleSvg({ canvas }: PreviewParts): SVGSVGElement | null {
  return [...canvas.querySelectorAll("svg")].find((svg) => svg.getClientRects().length > 0) ?? null;
}

interface Press {
  dragged: boolean;
}

/**
 * Wires up the Mermaid previews inside `container` (the markdown editor's root): `openViewer`
 * receives the code block's node view element, and `editorView` returns the editor that Edit and
 * Hide move the caret in. Returns a cleanup function.
 */
export function attachMermaidPreviewControls(
  container: HTMLElement,
  openViewer: (codeBlock: Element) => void,
  editorView: () => EditorView | undefined,
): () => void {
  /** The current press on a preview, so its click can tell a drag from a click. */
  let press: Press | null = null;

  const runAction = (action: Action, parts: PreviewParts) => {
    const center = { x: parts.viewport.clientWidth / 2, y: parts.viewport.clientHeight / 2 };
    const codeBlock = parts.diagram.closest(".milkdown-code-block");
    switch (action) {
      case "edit":
      case "hide": {
        const view = editorView();
        if (!view || !codeBlock) break;
        if (action === "edit") editCodeBlockSource(view, codeBlock);
        else hideCodeBlockSource(view, codeBlock);
        break;
      }
      case "zoom-in":
        zoom(parts, ZOOM_STEP, center);
        break;
      case "zoom-out":
        zoom(parts, 1 / ZOOM_STEP, center);
        break;
      case "reset":
        views.delete(parts.canvas);
        parts.canvas.style.transform = "";
        break;
      case "copy-svg":
      case "copy-png": {
        const svg = visibleSvg(parts);
        const format: DiagramCopyFormat = action === "copy-svg" ? "svg" : "png";
        if (svg) void copyDiagram(svg, format, surfaceColor(parts.viewport));
        break;
      }
      case "open":
        if (codeBlock) openViewer(codeBlock);
        break;
      default: {
        const unknown: never = action;
        throw new Error(`Unknown mermaid preview action: ${String(unknown)}`);
      }
    }
  };

  const handleClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const parts = previewParts(event.target);
    if (!parts) return;
    const option = event.target.closest(`[${ACTION_ATTR}]`)?.getAttribute(ACTION_ATTR);
    const action = ACTIONS.find((a) => a === option);
    if (action) {
      runAction(action, parts);
      return;
    }
    const pressed = press;
    press = null;
    if (!parts.viewport.contains(event.target) || pressed?.dragged) return;
    runAction("open", parts);
  };

  const handleMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    const parts = previewParts(event.target);
    if (!parts || !(event.target instanceof Node) || !parts.viewport.contains(event.target)) return;
    // Keep ProseMirror from starting a selection or moving the caret into the block.
    event.preventDefault();
    const current: Press = { dragged: false };
    const origin = { x: event.clientX, y: event.clientY };
    const startView = viewOf(parts);
    press = current;
    const handleMove = (move: MouseEvent) => {
      const dx = move.clientX - origin.x;
      const dy = move.clientY - origin.y;
      if (!current.dragged && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      current.dragged = true;
      parts.viewport.dataset.panning = "";
      setView(parts, { ...startView, x: startView.x + dx, y: startView.y + dy });
    };
    const handleUp = () => {
      delete parts.viewport.dataset.panning;
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  const handleWheel = (event: WheelEvent) => {
    const parts = previewParts(event.target);
    if (!parts || !(event.target instanceof Node) || !parts.viewport.contains(event.target)) return;
    if (isZoomWheel(event)) {
      event.preventDefault();
      const rect = parts.viewport.getBoundingClientRect();
      const at = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      zoom(parts, wheelZoomFactor(event.deltaY), at);
      return;
    }
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    const view = viewOf(parts);
    if (setView(parts, { ...view, x: view.x - event.deltaX })) event.preventDefault();
  };

  /**
   * Wheel listeners must be non-passive to cancel the event, and a non-passive listener makes the
   * browser wait for JS before scrolling. So each viewport gets its own when the pointer first
   * enters it, and the rest of the editor keeps scrolling off the main thread.
   */
  const wheelTargets = new WeakSet<HTMLElement>();
  const handlePointerOver = (event: PointerEvent) => {
    const viewport = previewParts(event.target)?.viewport;
    if (!viewport || wheelTargets.has(viewport)) return;
    wheelTargets.add(viewport);
    viewport.addEventListener("wheel", handleWheel, { passive: false });
  };

  // Capture phase: ProseMirror's own handlers on the editor must not see a press on a diagram first.
  container.addEventListener("mousedown", handleMouseDown, true);
  container.addEventListener("click", handleClick);
  container.addEventListener("pointerover", handlePointerOver);
  return () => {
    container.removeEventListener("mousedown", handleMouseDown, true);
    container.removeEventListener("click", handleClick);
    container.removeEventListener("pointerover", handlePointerOver);
    for (const viewport of container.querySelectorAll<HTMLElement>(
      `.${MERMAID_CLASSES.viewport}`,
    )) {
      viewport.removeEventListener("wheel", handleWheel);
    }
  };
}
