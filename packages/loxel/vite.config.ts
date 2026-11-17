import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { type Plugin, type ProxyOptions, defineConfig } from "vite";
import electron from "vite-plugin-electron";

import { DEFAULT_SERVER_PORT, parsePortEnv, vitePort } from "./src/app-ports";
import { bearer, readSessionToken } from "./src/app-session";
import { DEFAULT_STATE_DIR } from "./src/state-dir";

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

/**
 * Minimum contrast fixes, active only with a ratio set: light themes', in src/lib/loxel-theme.ts
 * (dark ones keep 1, which skips this code). Only the WebGL renderer is patched: a terminal on the
 * DOM fallback keeps stock xterm's handling of dim text.
 */
const XTERM_WEBGL_CONTRAST_PATCHES = [
  // Hold dim (SGR 2) text to the ratio as drawn. Stock xterm checks the undimmed color against half
  // the ratio and then draws it at 50% opacity, so dim text on white ends up near 2:1. Here the
  // check blends the color 50% over the background first, the way it is drawn, against 1.4 times
  // the full ratio (dim text is small secondary text); colors that fail are drawn opaque
  // at that ratio, which still keeps them lighter than normal text.
  {
    find: "I=this._resolveForegroundRgba(o,r,a,l),L=Te.ensureContrastRatio(f,I,this._config.minimumContrastRatio/(u?2:1))",
    replace:
      "I=this._resolveForegroundRgba(o,r,a,l);u&&(I=((f>>>24)+(I>>>24)>>1<<24|((f>>16&255)+(I>>16&255)>>1)<<16|((f>>8&255)+(I>>8&255)>>1)<<8|255)>>>0);let L=Te.ensureContrastRatio(f,I,this._config.minimumContrastRatio*(u?1.4:1))",
  },
  // When a color can't reach the ratio in its own direction (black text on a dark red swatch can't
  // get dark enough), stock xterm flips it only as far as the ratio, leaving a mid grey; flip it
  // all the way to white (or black) instead, so the text stays crisp.
  { find: "if(L<l){let M=n(r,a,l),q=", replace: "if(L<l){let M=n(r,a,21),q=" },
  { find: "if(f<l){let I=t(r,a,l),L=", replace: "if(f<l){let I=t(r,a,21),L=" },
];

/**
 * Give upright text in the glyph atlas an explicit `normal` style. The addon builds the canvas
 * font as `${italic} ${weight} ...`, which starts with a space for upright text; Electron 45's
 * Chromium rejects that value (electron/electron#55616) and the atlas stays on the canvas default
 * of 10px sans-serif. Upstream fix: xtermjs/xterm.js#6312. The addon's `_getFont` builds the same
 * string but only for `_fillCharTrueColor`, which nothing calls, so it is left as is.
 */
const XTERM_WEBGL_FONT_PATCHES = [
  {
    find: 'ue=I?"italic":"";this._tmpCtx.font=`${ue} ${G} ',
    replace: 'ue=I?"italic":"normal";this._tmpCtx.font=`${ue} ${G} ',
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
        ...XTERM_WEBGL_CONTRAST_PATCHES,
        ...XTERM_WEBGL_FONT_PATCHES,
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

/**
 * Proxy `/api` and `/ws` to the server at `serverPort`. For a browser (`pnpm run dev`,
 * `dev:client`), with the secret from the token file of a server started without the desktop app,
 * read on every request, since such a server makes a new one each time it restarts: dev only, and
 * while it runs, whatever reaches this port reaches the dev server's API. Under the dev app
 * (`dev:app`) it adds nothing: the app's main process adds the secret of the server it uses to its
 * windows' requests.
 */
function serverProxy(serverPort: number, stateDir: string, ws: boolean): ProxyOptions {
  const authorize = (proxyReq: {
    getHeader: (name: string) => unknown;
    setHeader: (name: string, value: string) => void;
  }) => {
    if (isElectron || proxyReq.getHeader("authorization") !== undefined) return;
    const secret = readSessionToken(stateDir);
    if (secret) proxyReq.setHeader("Authorization", bearer(secret));
  };
  return {
    target: `${ws ? "ws" : "http"}://127.0.0.1:${serverPort}`,
    ws,
    // changeOrigin rewrites Host to the server's own host:port; the server rejects requests whose
    // Host names any other port (src/server/request-origin.ts).
    changeOrigin: true,
    configure: (proxy) => {
      proxy.on("proxyReq", authorize);
      proxy.on("proxyReqWs", authorize);
    },
  };
}

export default defineConfig(({ mode }) => {
  const isDevMode = mode === "development";
  const serverPort =
    parsePortEnv("LOXEL_SERVE_PORT", process.env.LOXEL_SERVE_PORT) ??
    (isDevMode ? DEFAULT_SERVER_PORT.dev : DEFAULT_SERVER_PORT.production);
  const stateDir =
    process.env.LOXEL_STATE_DIR ??
    (isDevMode ? DEFAULT_STATE_DIR.dev : DEFAULT_STATE_DIR.production);

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
                      for (const file of [
                        "preload.cjs",
                        "webview-preload.cjs",
                        "service-worker-preload.cjs",
                      ]) {
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
      port: vitePort(process.env),
      strictPort: true,
      proxy: {
        "/api": serverProxy(serverPort, stateDir, false),
        // Every language server's socket too (`/ws/<lsp>`), by prefix.
        "/ws": serverProxy(serverPort, stateDir, true),
      },
    },
  };
});
