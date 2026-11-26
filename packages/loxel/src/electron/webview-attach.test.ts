import { describe, expect, mock, test } from "bun:test";

import type { WebPreferences } from "electron";

void mock.module("electron", () => ({ BrowserWindow: {}, ipcMain: { on: () => {} } }));

const { BROWSER_PARTITION, INCOGNITO_PARTITION } = await import("./browser-partition");
const { secureWebviewAttach } = await import("./webview-attach");

const incognitoPartition = () => "incognito-7";

/** Everything an element (or a compromised window renderer) could ask a webview for. */
const asked = (): WebPreferences => ({
  partition: "persist:other",
  preload: "/tmp/evil.js",
  nodeIntegration: true,
  nodeIntegrationInWorker: true,
  contextIsolation: false,
  sandbox: false,
  webSecurity: false,
  allowRunningInsecureContent: true,
  webviewTag: true,
  experimentalFeatures: true,
  enableBlinkFeatures: "SomeFeature",
  disableBlinkFeatures: "SomeFeature",
  plugins: true,
  navigateOnDragDrop: true,
});

describe("secureWebviewAttach", () => {
  test("forces the browser partition, Loxel's sandboxed preload and secure preferences", () => {
    const webPreferences = asked();
    expect(secureWebviewAttach(webPreferences, { src: "about:blank" }, incognitoPartition)).toBe(
      true,
    );
    expect(webPreferences).toMatchObject({
      partition: BROWSER_PARTITION,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      experimentalFeatures: false,
      plugins: false,
      navigateOnDragDrop: false,
    });
    expect(webPreferences.preload).toEndWith("/webview-preload.cjs");
    expect(webPreferences).not.toHaveProperty("enableBlinkFeatures");
    expect(webPreferences).not.toHaveProperty("disableBlinkFeatures");
  });

  test("attaches webviews that start blank or on a web page only", () => {
    const attaches = (src: string | undefined) =>
      secureWebviewAttach(asked(), { src }, incognitoPartition);
    expect(attaches("about:blank")).toBe(true);
    expect(attaches("https://example.com/")).toBe(true);
    expect(attaches("http://localhost:5173/")).toBe(true);
    expect(attaches("view-source:https://example.com/")).toBe(true);
    for (const src of [
      "file:///etc/passwd",
      "data:text/html,<p>hi</p>",
      "javascript:alert(1)",
      "view-source:file:///etc/passwd",
      "about:srcdoc",
      "chrome://gpu",
      "",
      undefined,
    ]) {
      expect(attaches(src)).toBe(false);
    }
  });

  test("puts a webview asking for incognito in the incognito session, and any other in the browser partition", () => {
    const partitionFor = (partition: string | undefined) => {
      const webPreferences = asked();
      secureWebviewAttach(webPreferences, { src: "about:blank", partition }, incognitoPartition);
      return webPreferences.partition;
    };
    expect(partitionFor(INCOGNITO_PARTITION)).toBe("incognito-7");
    for (const partition of [undefined, "", "persist:other", "incognito-7", BROWSER_PARTITION]) {
      expect(partitionFor(partition)).toBe(BROWSER_PARTITION);
    }
  });
});
