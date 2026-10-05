/**
 * WebGL renderer lifecycle for a terminal.
 *
 * The WebGL renderer draws block elements and box-drawing characters as custom glyphs that fill
 * the cell exactly (like native terminals), where the DOM renderer's font glyphs leave seams under
 * line height and fractional cell widths. vite.config.ts snaps those glyphs and the cell width to
 * whole device pixels.
 *
 * Chromium allows ~16 live WebGL contexts per window and force-loses the oldest beyond that, so a
 * terminal only holds one while its panel is visible: hidden tabs fall back to the DOM renderer and
 * re-acquire WebGL when shown again (which also retries after a context loss).
 */

import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

import { frontendLog } from "@/lib/frontend-logger";

const log = frontendLog.child("terminal");

export interface WebglRenderer {
  /** Switch to the WebGL renderer. No-op if already attached or the terminal isn't open yet. */
  attach(): void;
  /** Switch back to the DOM renderer and release the WebGL context. */
  detach(): void;
}

/**
 * @param onContextLoss Runs after an unrequested fallback to the DOM renderer (GPU reset, context
 * cap), whose cell metrics differ, so the caller can refit.
 */
export function createWebglRenderer(
  terminal: Terminal,
  terminalId: string,
  onContextLoss: () => void,
): WebglRenderer {
  let addon: WebglAddon | null = null;

  const dispose = ({ releaseContext }: { releaseContext: boolean }) => {
    if (!addon) return;
    const canvases = terminal.element ? [...terminal.element.querySelectorAll("canvas")] : [];
    addon.dispose();
    addon = null;
    if (!releaseContext) return;
    // The addon leaves its context to GC, which counts against the cap until then. getContext
    // returns the existing context (null for xterm's 2D canvases), never creating a new one.
    for (const canvas of canvases) {
      canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
    }
  };

  return {
    attach() {
      if (addon || !terminal.element) return;
      try {
        const next = new WebglAddon();
        next.onContextLoss(() => {
          log.warn("WebGL context lost, falling back to DOM renderer", { terminalId });
          dispose({ releaseContext: false });
          onContextLoss();
        });
        terminal.loadAddon(next);
        addon = next;
      } catch (error) {
        log.warn("WebGL renderer unavailable, using DOM renderer", { terminalId, error });
      }
    },
    detach() {
      dispose({ releaseContext: true });
    },
  };
}
