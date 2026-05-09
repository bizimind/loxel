import fs from "node:fs";
import path from "node:path";

import { createCanvas, GlobalFonts, getFontsDir } from "./canvas-loader.ts";

const g = globalThis as Record<string, unknown>;

let active = false;
let savedGlobals: Record<string, unknown> | null = null;
let fontsRegistered = false;

/**
 * Register the bundled Excalidraw fonts under all names excalidraw references.
 * Excalidraw's FONT_FAMILY maps: Virgil(1), Helvetica(2), Cascadia(3), Excalifont(5),
 * plus fallbacks like "Liberation Sans"(9) and generic families.
 */
function registerFonts(): void {
  if (fontsRegistered) return;
  const fontsDir = getFontsDir();
  const virgil = fs.readFileSync(path.join(fontsDir, "Virgil-Regular.ttf"));
  const cascadia = fs.readFileSync(path.join(fontsDir, "CascadiaCode-Regular.ttf"));
  const liberation = fs.readFileSync(path.join(fontsDir, "LiberationSans-Regular.ttf"));

  // Register under all names excalidraw may use in CSS font strings
  for (const name of ["Virgil", "Excalifont"]) GlobalFonts.register(virgil, name);
  for (const name of ["Cascadia", "Cascadia Code"]) GlobalFonts.register(cascadia, name);
  for (const name of ["Helvetica", "Liberation Sans"]) GlobalFonts.register(liberation, name);

  fontsRegistered = true;
}

/**
 * Run a function with DOM globals available.
 * Required for @excalidraw/element and @excalidraw/utils which access
 * `window`, `document`, etc. at import and call time.
 *
 * Uses linkedom for DOM globals and @napi-rs/canvas for real Canvas 2D support.
 */
let refCount = 0;

export async function withDom<T>(fn: () => T | Promise<T>): Promise<T> {
  refCount++;
  if (!active) {
    const { parseHTML } = await import("linkedom");
    const parsed = parseHTML("<!DOCTYPE html><html><head></head><body></body></html>");
    const { window, document } = parsed;

    savedGlobals = {
      window: g.window,
      document: g.document,
      navigator: g.navigator,
      DOMParser: g.DOMParser,
      Element: g.Element,
      HTMLElement: g.HTMLElement,
      devicePixelRatio: g.devicePixelRatio,
      self: g.self,
      location: g.location,
      getComputedStyle: g.getComputedStyle,
    };

    // Patch createElement to return a canvas backed by @napi-rs/canvas.
    // Excalidraw expects an HTMLCanvasElement (with setAttribute, style, etc.)
    // but needs a real Canvas 2D context for text measurement and rendering.
    // Solution: create a linkedom element for DOM methods, proxy getContext()
    // to @napi-rs/canvas for the actual 2D context.
    const origCreateElement = document.createElement.bind(document);
    const doc = document as unknown as Record<string, unknown>;
    doc.createElement = (tag: string, ..._args: unknown[]) => {
      if (tag.toLowerCase() === "canvas") {
        const domEl = origCreateElement("canvas") as unknown as Record<string, unknown>;
        const nativeCanvas = createCanvas(300, 150);
        // Store native canvas reference for cross-canvas drawImage interop
        domEl.__nativeCanvas = nativeCanvas;
        domEl.getContext = (type: string) => {
          if (type === "2d") {
            const ctx = nativeCanvas.getContext("2d");
            // Proxy the context so ctx.canvas returns the DOM element (with
            // setAttribute etc.) instead of the @napi-rs/canvas object.
            // The native canvas property is non-configurable, so we use a Proxy.
            return new Proxy(ctx, {
              get(target, prop) {
                if (prop === "canvas") return domEl;
                const val = Reflect.get(target, prop);
                if (typeof val !== "function") return val;
                // Intercept drawImage to unwrap hybrid canvas sources.
                // When compositing one canvas onto another, @napi-rs/canvas
                // needs the native canvas object, not the linkedom DOM element.
                if (prop === "drawImage") {
                  return function drawImagePatched(
                    source: Record<string, unknown>,
                    ...restArgs: unknown[]
                  ) {
                    const realSource =
                      (source as Record<string, unknown>)?.__nativeCanvas ?? source;
                    return val.call(target, realSource, ...restArgs);
                  };
                }
                return val.bind(target);
              },
              set(target, prop, value) {
                return Reflect.set(target, prop, value);
              },
            });
          }
          return null;
        };
        domEl.toDataURL = () => "data:,";
        domEl.toBuffer = (mime: string) => nativeCanvas.toBuffer(mime as "image/png");
        // Sync dimensions between DOM element and native canvas
        const origSetAttribute = (
          domEl.setAttribute as (name: string, value: string) => void
        )?.bind(domEl);
        domEl.setAttribute = (name: string, value: string) => {
          if (name === "width") nativeCanvas.width = parseInt(value, 10) || 300;
          else if (name === "height") nativeCanvas.height = parseInt(value, 10) || 150;
          origSetAttribute?.(name, value);
        };
        Object.defineProperty(domEl, "width", {
          get: () => nativeCanvas.width,
          set: (v: number) => {
            nativeCanvas.width = v;
          },
        });
        Object.defineProperty(domEl, "height", {
          get: () => nativeCanvas.height,
          set: (v: number) => {
            nativeCanvas.height = v;
          },
        });
        return domEl;
      }
      return origCreateElement(tag);
    };

    // Provide document.fonts stub — excalidraw checks font availability via the
    // FontFaceSet API. Without it, all fonts appear unavailable and text falls
    // back to "Segoe UI Emoji". We check against our registered fonts.
    const registeredFamilies = new Set([
      "virgil",
      "excalifont",
      "cascadia",
      "cascadia code",
      "helvetica",
      "liberation sans",
    ]);
    if (!doc.fonts) {
      doc.fonts = {
        check: (fontSpec: string) => {
          // fontSpec is like "20px Virgil" — extract the family name
          const family = (fontSpec.replace(/^\s*\d+(\.\d+)?px\s+/, "").split(",")[0] ?? "")
            .trim()
            .toLowerCase();
          return registeredFamilies.has(family);
        },
        load: async () => [],
        ready: Promise.resolve(),
        status: "loaded",
        forEach: () => {},
        entries: () => [][Symbol.iterator](),
        keys: () => [][Symbol.iterator](),
        values: () => [][Symbol.iterator](),
        [Symbol.iterator]: () => [][Symbol.iterator](),
      };
    }

    // Patch Element prototype to compute offsetWidth/offsetHeight from font metrics.
    // @excalidraw/utils measures text by creating a <div>, setting style.font and
    // innerText, then reading offsetWidth/Height. linkedom returns 0 for these
    // since it doesn't do layout. We compute on access using @napi-rs/canvas.
    //
    // Also handles mermaid's foreignObject divs which inherit fonts from CSS classes
    // rather than setting style.font directly — we resolve the font from individual
    // style properties or fall back to a reasonable default.
    const measureCanvas = createCanvas(1, 1);
    const measureCtx = measureCanvas.getContext("2d");
    const defaultFont = "16px sans-serif";

    /** Resolve a CSS font string from an element's style properties. */
    const resolveElementFont = (el: Record<string, unknown>): string | null => {
      const style = el.style as Record<string, string> | undefined;
      if (!style) return null;
      // Prefer explicit shorthand
      if (style.font) return style.font;
      // Construct from individual properties (mermaid sets these via CSS classes,
      // but they may appear on parent elements or via inline style)
      const fontSize = style.fontSize;
      const fontFamily = style.fontFamily;
      if (fontSize || fontFamily) {
        return `${fontSize || "16px"} ${fontFamily || "sans-serif"}`;
      }
      return null;
    };

    /** Walk up the DOM tree to find a font, falling back to default. */
    const resolveInheritedFont = (el: Record<string, unknown>): string => {
      let node: Record<string, unknown> | null = el;
      while (node) {
        const font = resolveElementFont(node);
        if (font) return font;
        node = (node as unknown as Element).parentElement as unknown as Record<string, unknown>;
      }
      // If no font found anywhere, use default. This handles mermaid's foreignObject
      // divs where font is set by CSS classes that linkedom can't resolve.
      return defaultFont;
    };

    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
    for (const prop of ["offsetWidth", "offsetHeight", "offsetTop"] as const) {
      const orig = Object.getOwnPropertyDescriptor(proto, prop);
      Object.defineProperty(proto, prop, {
        get(this: Record<string, unknown>) {
          const text = String(this.innerText ?? this.textContent ?? "");
          if (!text) return orig?.get?.call(this) ?? 0;
          const font = resolveInheritedFont(this);
          measureCtx.font = font;
          const lines = text.split("\n");
          const metrics = measureCtx.measureText(lines[0] || "M");
          const lineH =
            (metrics.fontBoundingBoxAscent ?? 0) + (metrics.fontBoundingBoxDescent ?? 0);
          if (prop === "offsetWidth") {
            return Math.ceil(Math.max(...lines.map((l) => measureCtx.measureText(l).width)));
          }
          if (prop === "offsetHeight") {
            return Math.ceil(lineH * lines.length);
          }
          // offsetTop: for the baseline <span>, return ascent
          return Math.ceil(metrics.fontBoundingBoxAscent ?? lineH * 0.8) - 1;
        },
        configurable: true,
      });
    }

    // --- SVG measurement stubs ---
    // linkedom doesn't implement SVG geometry methods. We provide accurate
    // implementations using @napi-rs/canvas for text and svg-path-bbox for paths.
    const { computeBBox, computeClientRect, computeTextLength, createComputedStyle } =
      await import("./svg-measure.ts");

    const elemProto = window.Element.prototype as unknown as Record<string, unknown>;

    if (!elemProto.getBBox) {
      elemProto.getBBox = function (this: Element) {
        return computeBBox(this);
      };
    }

    if (!elemProto.getComputedTextLength) {
      elemProto.getComputedTextLength = function (this: Element) {
        return computeTextLength(this);
      };
    }

    // Patch getBoundingClientRect to return accurate values (linkedom returns all zeros)
    elemProto.getBoundingClientRect = function (this: Element) {
      return computeClientRect(this);
    };

    // getComputedStyle — reads inline style + SVG presentation attributes
    const win = window as unknown as Record<string, unknown>;
    if (!win.getComputedStyle) {
      win.getComputedStyle = (el: Element) => createComputedStyle(el);
      g.getComputedStyle = win.getComputedStyle;
    }

    g.window = window;
    g.document = document;
    g.navigator = window.navigator;
    g.DOMParser = window.DOMParser;
    g.Element = window.Element;
    g.HTMLElement = window.HTMLElement;
    g.devicePixelRatio = 1;
    g.self = window;
    if (!g.location) {
      g.location = { href: "https://localhost", origin: "https://localhost" };
    }
    if (!g.requestAnimationFrame) {
      g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
      g.cancelAnimationFrame = (id: number) => clearTimeout(id);
    }
    active = true;

    registerFonts();
  }

  try {
    return await fn();
  } finally {
    refCount--;
    if (refCount === 0 && savedGlobals) {
      Object.assign(g, savedGlobals);
      active = false;
      savedGlobals = null;
    }
  }
}
