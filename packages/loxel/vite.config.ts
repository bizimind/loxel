import type { PluginOption } from "vite";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import electron from "vite-plugin-electron";

const isElectron = !!process.env.ELECTRON;

export default defineConfig(({ mode }) => {
  const serverPort = mode === "development" ? 7434 : 7433;

  return {
    plugins: [
      react(),
      tailwindcss(),
      ...(isElectron
        ? (electron([
            {
              entry: path.join(import.meta.dirname, "src/electron/main.ts"),
              onstart(args) {
                args.startup();
              },
              vite: {
                build: {
                  outDir: path.join(import.meta.dirname, "dist-electron/main"),
                  rollupOptions: { external: ["electron"] },
                },
                plugins: [
                  {
                    // Copy preload.cjs as-is — sandboxed Electron renderers require CJS,
                    // but vite-plugin-electron converts to ESM.
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
          ]) as PluginOption[])
        : []),
    ],
    base: "./",
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
        // Monaco 0.56 exposes its worker modules through paths that Rolldown cannot resolve
        // through the package export map; keep those browser worker imports on concrete files.
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
