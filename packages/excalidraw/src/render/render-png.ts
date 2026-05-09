import type { ExcalidrawElement } from "../elements/excalidraw-types.ts";
import type { ExcalidrawFile } from "../file/excalidraw-file.ts";

import { withDom } from "../dom-shim.ts";
import { activeElements } from "../elements/element-query.ts";

interface RenderOptions {
  scale: number;
  padding: number;
  filterIds?: string[];
}

/**
 * Render an excalidraw file to PNG via direct canvas rendering.
 *
 * Uses @excalidraw/element's renderElement with rough.js to draw directly
 * onto an @napi-rs/canvas surface (provided by the dom-shim), bypassing
 * the previous SVG → resvg-wasm pipeline.
 */
export async function renderToPng(file: ExcalidrawFile, opts: RenderOptions): Promise<Uint8Array> {
  return withDom(async () => {
    // Dynamic imports — must run inside withDom so DOM globals exist
    const {
      renderElement,
      getBoundTextElement,
      getCommonBounds,
      isIframeLikeElement,
      isTextElement,
      syncInvalidIndices,
    } = await import("@excalidraw/element");
    const rough = (await import("roughjs")).default;

    const allElements = activeElements(file.elements);
    if (allElements.length === 0) throw new Error("No visible elements to render");

    // Build element maps (renderElement expects Map<id, element>)
    // @ts-expect-error -- our loose ExcalidrawElement satisfies the library at runtime
    const synced = syncInvalidIndices(allElements) as ExcalidrawElement[];
    const elementsMap = new Map(synced.map((e) => [e.id, e]));

    // Filter elements if IDs were specified (e.g. piped from query --ids)
    let renderTargets = synced;
    if (opts.filterIds && opts.filterIds.length > 0) {
      const filterSet = new Set(opts.filterIds);
      // Auto-include bound text elements for filtered elements
      for (const el of synced) {
        if (!filterSet.has(el.id)) continue;
        const bound = el.boundElements as Array<{ id: string; type: string }> | null;
        if (bound) {
          for (const b of bound) {
            if (b.type === "text") filterSet.add(b.id);
          }
        }
      }
      renderTargets = synced.filter((el) => filterSet.has(el.id));
      if (renderTargets.length === 0) throw new Error("No visible elements to render");
    }

    // Compute bounds from the elements we'll actually render
    // @ts-expect-error -- our loose ExcalidrawElement satisfies the library at runtime
    const [minX, minY, maxX, maxY] = getCommonBounds(renderTargets) as [
      number,
      number,
      number,
      number,
    ];
    const width = Math.abs(maxX - minX) + opts.padding * 2;
    const height = Math.abs(maxY - minY) + opts.padding * 2;

    // Create canvas via document.createElement — goes through the dom-shim
    // which returns a hybrid canvas backed by @napi-rs/canvas
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * opts.scale);
    canvas.height = Math.ceil(height * opts.scale);

    const context = canvas.getContext("2d")!;

    // Bootstrap: reset transform, apply scale
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.scale(opts.scale, opts.scale);

    // Fill background (always dark mode)
    const viewBgColor = (file.appState.viewBackgroundColor as string) ?? "transparent";
    const isTransparent = viewBgColor === "transparent";
    const bgColor = isTransparent ? "transparent" : "#121212";

    if (!isTransparent) {
      context.fillStyle = bgColor;
      context.fillRect(0, 0, width, height);
    } else {
      context.clearRect(0, 0, width, height);
    }

    // Create rough.js canvas for hand-drawn style rendering
    const rc = rough.canvas(canvas);

    const theme = "dark";

    const renderConfig = {
      imageCache: new Map(),
      renderGrid: false,
      isExporting: true,
      embedsValidationStatus: new Map(),
      elementsPendingErasure: new Set(),
      pendingFlowchartNodes: null,
      theme,
    };

    const appState = {
      scrollX: -minX + opts.padding,
      scrollY: -minY + opts.padding,
      zoom: { value: 1 },
      theme,
      exportScale: opts.scale,
      shouldCacheIgnoreZoom: false,
      frameRendering: { enabled: false, name: false, outline: false, clip: false },
      viewBackgroundColor: !isTransparent ? bgColor : null,
      selectedElementIds: {},
      hoveredElementIds: {},
      openDialog: null,
      frameToHighlight: null,
    };

    // Render each element onto the canvas
    for (const element of renderTargets) {
      // @ts-expect-error -- our loose ExcalidrawElement satisfies the library at runtime
      if (isIframeLikeElement(element)) continue;
      // Skip bound text — rendered with its container
      // @ts-expect-error -- our loose ExcalidrawElement satisfies the library at runtime
      if (isTextElement(element) && element.containerId && elementsMap.has(element.containerId)) {
        continue;
      }

      context.save();
      // @ts-expect-error -- our loose ExcalidrawElement / elementsMap satisfies the library at runtime
      renderElement(element, elementsMap, elementsMap, rc, context, renderConfig, appState);

      // @ts-expect-error -- our loose ExcalidrawElement satisfies the library at runtime
      const boundText = getBoundTextElement(element, elementsMap);
      if (boundText) {
        // @ts-expect-error -- our loose ExcalidrawElement / elementsMap satisfies the library at runtime
        renderElement(boundText, elementsMap, elementsMap, rc, context, renderConfig, appState);
      }
      context.restore();
    }

    // Export to PNG buffer — toBuffer is added by the dom-shim's canvas hybrid
    return new Uint8Array(
      (canvas as unknown as { toBuffer(mime: string): Buffer }).toBuffer("image/png"),
    );
  });
}
