import { describe, expect, test } from "bun:test";

import { carriesSecret } from "./app-server";

const APP = "http://127.0.0.1:7433";
const fromWindow = (url: string, frameOrigin: string | undefined = APP) =>
  carriesSecret({ url, contentsType: "window", frameOrigin }, APP);

describe("carriesSecret", () => {
  test("the app's own requests to its server's API and sockets", () => {
    expect(fromWindow(`${APP}/api/projects`)).toBe(true);
    expect(fromWindow("ws://127.0.0.1:7433/ws")).toBe(true);
    expect(fromWindow("ws://127.0.0.1:7433/ws/ts-lsp?wt=/x")).toBe(true);
    // A worker's request has no frame.
    expect(fromWindow(`${APP}/api/log`, undefined)).toBe(true);
    expect(carriesSecret({ url: `${APP}/api/log` }, APP)).toBe(true);
  });

  test("never another origin, another port on the same host included", () => {
    expect(fromWindow("http://127.0.0.1:3000/api/projects")).toBe(false);
    expect(fromWindow("ws://127.0.0.1:3000/ws")).toBe(false);
    expect(fromWindow("http://localhost:7433/api/projects")).toBe(false);
    expect(fromWindow("https://127.0.0.1:7433/api/projects")).toBe(false);
  });

  test("not the renderer's static files", () => {
    expect(fromWindow(`${APP}/`)).toBe(false);
    expect(fromWindow(`${APP}/assets/index.js`)).toBe(false);
  });

  test("not a webview's, nor a frame from another origin", () => {
    const url = `${APP}/api/projects`;
    expect(carriesSecret({ url, contentsType: "webview", frameOrigin: APP }, APP)).toBe(false);
    expect(fromWindow(url, "https://example.com")).toBe(false);
    expect(fromWindow(url, "null")).toBe(false);
  });

  test("the Vite dev server's origin in dev", () => {
    const vite = "http://127.0.0.1:5173";
    const req = (url: string) => ({ url, contentsType: "window", frameOrigin: vite });
    expect(carriesSecret(req(`${vite}/api/projects`), vite)).toBe(true);
    expect(carriesSecret(req("ws://127.0.0.1:5173/ws"), vite)).toBe(true);
    expect(carriesSecret(req(`${APP}/api/projects`), vite)).toBe(false);
  });
});
