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

/**
 * Add `WebglAddon.setRowTransform` (typed in src/components/terminal/webgl-renderer.ts), which the
 * terminal uses to draw bidirectional text. For each row `_updateModel` draws, the transform names
 * the logical cell to draw in each visual column (`$bx`) and the mirrored characters. Selection and
 * decorations resolve against the logical column, the cursor is drawn where its logical cell lands
 * (`$bc`), and character joining is skipped on transformed rows. Same exactly-once rule as above.
 */
const XTERM_WEBGL_ROW_TRANSFORM_PATCHES = [
  {
    find: "let s=this._core,o=this._workCell,r,a,l,u,c,d,h=0,f=!0,I,L,M,q,S,W,E,y,w;",
    replace:
      "let s=this._core,o=this._workCell,r,a,l,u,c,d,h=0,f=!0,I,L,M,q,S,W,E,y,w,$bd,$bx,$bc=1/0;",
  },
  {
    find: "c=this._characterJoinerService.getJoinedCharacters(l),y=0;",
    replace:
      "c=this._characterJoinerService.getJoinedCharacters(l),$bd=this._rowTransform?.(l),$bd&&(c=[]),y=0;",
  },
  { find: "u.loadCell(y,o)", replace: "$bx=$bd?$bd.visualToLogical[y]:y,u.loadCell($bx,o)" },
  {
    find: "if(q=o.getChars(),S=o.getCode(),E=(a*s.cols+y)*Ce,this._cellColorResolver.resolve(o,y,l,",
    replace:
      "if(q=o.getChars(),S=o.getCode(),$bd?.mirrored.has($bx)&&(q=$bd.mirrored.get($bx),S=q.codePointAt(0)),E=(a*s.cols+y)*Ce,this._cellColorResolver.resolve(o,$bx,l,",
  },
  {
    find: "(y===ce&&(this._model.cursor={x:ce,",
    replace: "($bx===ce&&(this._model.cursor={x:$bc=y,",
  },
  { find: "we=ce+o.getWidth()-1),y>=ce&&y<=we&&", replace: "we=y+o.getWidth()-1),y>=$bc&&y<=we&&" },
  {
    find: "this._renderer=this._register(new ui(t,l,u,c,s,d,o,f,this._preserveDrawingBuffer)),",
    replace:
      "this._renderer=this._register(new ui(t,l,u,c,s,d,o,f,this._preserveDrawingBuffer)),this._renderer._rowTransform=(e=>this._rowTransform?.(e)),",
  },
  {
    find: "clearTextureAtlas(){this._renderer?.clearTextureAtlas()}",
    replace:
      "clearTextureAtlas(){this._renderer?.clearTextureAtlas()}setRowTransform(e){this._rowTransform=e}",
  },
];

function xtermWebglPatches(): Plugin {
  let isBuild = false;
  let patched = false;
  return {
    name: "xterm-webgl-patches",
    enforce: "pre",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    buildEnd(error) {
      // Dev serves modules on demand; in a build the addon must have gone through the transform.
      if (!isBuild || error || patched) return;
      this.error(`xterm-webgl-patches: ${XTERM_WEBGL_MODULE} was never transformed`);
    },
    transform(code, id) {
      if (!id.includes(XTERM_WEBGL_MODULE)) return null;
      let source = code;
      for (const { find, replace } of [
        ...XTERM_WEBGL_PIXEL_GRID_PATCHES,
        ...XTERM_WEBGL_ROW_TRANSFORM_PATCHES,
      ]) {
        if (source.split(find).length !== 2) {
          throw new Error(`xterm-webgl-patches: expected one match in ${id} for: ${find}`);
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
      xtermWebglPatches(),
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
                    // Keep the preloads byte-for-byte CJS for sandboxed Electron renderers;
                    // this type:module package defaults Electron builds to ESM.
                    name: "copy-preload",
                    closeBundle() {
                      const outDir = path.join(import.meta.dirname, "dist-electron/main");
                      mkdirSync(outDir, { recursive: true });
                      for (const file of ["preload.cjs", "webview-preload.cjs"]) {
                        const src = path.join(import.meta.dirname, "src/electron", file);
                        copyFileSync(src, path.join(outDir, file));
                      }
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
      // The server only admits this origin in dev (src/server/request-origin.ts), so fail
      // loudly instead of silently moving to another port.
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": { target: `http://127.0.0.1:${serverPort}`, changeOrigin: true },
        // changeOrigin rewrites Host to the server's own host:port; the server rejects upgrades
        // whose Host names any other port (src/server/request-origin.ts).
        "/ws/yaml-lsp": { target: `ws://127.0.0.1:${serverPort}`, ws: true, changeOrigin: true },
        "/ws/ts-lsp": { target: `ws://127.0.0.1:${serverPort}`, ws: true, changeOrigin: true },
        "/ws": { target: `ws://127.0.0.1:${serverPort}`, ws: true, changeOrigin: true },
      },
    },
  };
});
