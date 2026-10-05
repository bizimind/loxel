import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";
import electron from "vite-plugin-electron";

const isElectron = !!process.env.ELECTRON;

const XTERM_WEBGL_MODULE = "@xterm/addon-webgl/lib/addon-webgl.mjs";

/**
 * Snap @xterm/addon-webgl to the device pixel grid the way native terminals (Ghostty) do, so
 * block-element art like the Claude Code mascot renders seamlessly at every zoom level:
 * - Cell width is rounded instead of floored, staying within 0.5px of the font's advance
 *   (flooring makes text up to ~10% tighter at 1x).
 * - Block element rects get whole-pixel edges. Fractional eighths leave anti-aliased seams where
 *   quadrants/halves meet, e.g. inside `▛` when the cell width is odd.
 * Each replacement must match exactly once, so an addon upgrade fails the build instead of
 * silently dropping the fix.
 */
const XTERM_WEBGL_PIXEL_GRID_PATCHES = [
  {
    find: "this.dimensions.device.char.width=Math.floor(this._charSizeService.width*this._devicePixelRatio)",
    replace:
      "this.dimensions.device.char.width=Math.round(this._charSizeService.width*this._devicePixelRatio)",
  },
  {
    find: "let a=e[r],l=s/8,u=o/8;i.fillRect(t+a.x*l,n+a.y*u,a.w*l,a.h*u)",
    replace:
      "let a=e[r],l=Math.round(a.x*s/8),u=Math.round(a.y*o/8);i.fillRect(t+l,n+u,Math.max(1,Math.round((a.x+a.w)*s/8)-l),Math.max(1,Math.round((a.y+a.h)*o/8)-u))",
  },
];

function xtermWebglPixelGrid(): Plugin {
  let isBuild = false;
  let patched = false;
  return {
    name: "xterm-webgl-pixel-grid",
    enforce: "pre",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    buildEnd(error) {
      // Dev serves modules on demand; in a build the addon must have gone through the transform.
      if (!isBuild || error || patched) return;
      this.error(`xterm-webgl-pixel-grid: ${XTERM_WEBGL_MODULE} was never transformed`);
    },
    transform(code, id) {
      if (!id.includes(XTERM_WEBGL_MODULE)) return null;
      let source = code;
      for (const { find, replace } of XTERM_WEBGL_PIXEL_GRID_PATCHES) {
        if (source.split(find).length !== 2) {
          throw new Error(`xterm-webgl-pixel-grid: expected one match in ${id} for: ${find}`);
        }
        source = source.replace(find, () => replace);
      }
      patched = true;
      return { code: source, map: null };
    },
  };
}

export default defineConfig(({ mode }) => {
  const serverPort = mode === "development" ? 7434 : 7433;

  return {
    plugins: [
      react(),
      tailwindcss(),
      xtermWebglPixelGrid(),
      ...(isElectron
        ? electron([
            {
              entry: path.join(import.meta.dirname, "src/electron/main.ts"),
              onstart(args) {
                args.startup();
              },
              vite: {
                build: { outDir: path.join(import.meta.dirname, "dist-electron/main") },
                plugins: [
                  {
                    // Keep preload.cjs byte-for-byte CJS for sandboxed Electron renderers;
                    // this type:module package defaults Electron builds to ESM.
                    name: "copy-preload",
                    closeBundle() {
                      const src = path.join(import.meta.dirname, "src/electron/preload.cjs");
                      const dest = path.join(import.meta.dirname, "dist-electron/main/preload.cjs");
                      mkdirSync(path.dirname(dest), { recursive: true });
                      copyFileSync(src, dest);
                    },
                  },
                ],
              },
            },
          ])
        : []),
    ],
    base: "./",
    // Pre-bundled deps skip plugin transforms; the addon is a single dependency-free ESM file.
    optimizeDeps: { exclude: ["@xterm/addon-webgl"] },
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
        // Monaco 0.56's export map resolves every subpath under `esm/vs/`, so the legacy
        // `monaco-editor/esm/vs/...` specifiers (still used for Monaco internals in
        // CodeEditorPanel) need this alias to reach concrete files. Worker `?worker` imports must
        // NOT use it: in dev the dependency optimizer pre-bundles aliased `?worker` imports as the
        // raw worker code with no default export. See src/lib/monaco-env.ts.
        "monaco-editor/esm/vs": path.resolve(
          import.meta.dirname,
          "node_modules/monaco-editor/esm/vs",
        ),
        // @hediet/json-rpc-websocket imports `ws` for Node.js — shim to nothing in browser
        ws: path.resolve(import.meta.dirname, "./src/lib/ws-shim.ts"),
      },
    },
    build: {
      outDir: isElectron ? path.join(import.meta.dirname, "dist-electron/renderer") : "dist",
      emptyOutDir: true,
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        "/api": { target: `http://127.0.0.1:${serverPort}`, changeOrigin: true },
        "/ws/yaml-lsp": { target: `ws://127.0.0.1:${serverPort}`, ws: true },
        "/ws/ts-lsp": { target: `ws://127.0.0.1:${serverPort}`, ws: true },
        "/ws": { target: `ws://127.0.0.1:${serverPort}`, ws: true },
      },
    },
  };
});
