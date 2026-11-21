import { describe, expect, spyOn, test } from "bun:test";

import * as monaco from "monaco-editor";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { IOpenerService } from "monaco-editor/platform/opener/common/opener.js";

import { installLinkPolicy, shouldOpenLink } from "./link-policy";

const APP_ORIGIN = "http://127.0.0.1:7433";
const BASE = `${APP_ORIGIN}/`;
const opens = (target: string | monaco.Uri) => shouldOpenLink(target, BASE, APP_ORIGIN);

describe("shouldOpenLink", () => {
  test("opens web links to other origins as written", () => {
    expect(opens("https://www.google.com/search?q=c%2B%2B+templates")).toBe(true);
    expect(opens("http://localhost:3000/")).toBe(true);
    expect(opens(monaco.Uri.parse("https://example.com/docs#top"))).toBe(true);
  });

  test("does not open web links that land on the app's own origin", () => {
    for (const link of [
      `${APP_ORIGIN}/api/version`,
      "HTTP://127.0.0.1:7433/",
      "http:/api/version",
      "http:api/version",
      "http:",
      "http://127.0.0.1:7433\\@example.com/",
      " http://127.0.0.1:7433/",
    ]) {
      expect(opens(link)).toBe(false);
    }
    expect(opens(monaco.Uri.parse(`${APP_ORIGIN}/api/version`))).toBe(false);
  });

  test("never runs command: links", () => {
    expect(opens("command:editor.action.selectAll")).toBe(false);
    expect(opens(" COMMAND:editor.action.selectAll?%5B%5D")).toBe(false);
    expect(opens(monaco.Uri.parse("command:editor.action.selectAll"))).toBe(false);
  });

  test("leaves file and editor links to the editor opener", () => {
    expect(opens("file:///repo/src/main.ts")).toBe(true);
    expect(opens(monaco.Uri.parse("loxel://server/repo/main.ts"))).toBe(true);
  });
});

describe("installLinkPolicy", () => {
  test("Monaco opens allowed web links as written and never opens refused ones", async () => {
    // happy-dom's page is `about:blank`; the app's is served from its own origin.
    const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
    happyDOM.setURL(`${APP_ORIGIN}/`);
    const policy = installLinkPolicy();
    const windowOpen = spyOn(window, "open").mockImplementation(() => null);
    const openerService = StandaloneServices.get(IOpenerService) as unknown as {
      open(target: string, options?: object): Promise<boolean>;
    };
    try {
      const link = "https://www.google.com/search?q=c%2B%2B+templates";
      await openerService.open(link, { fromUserGesture: true });
      await openerService.open(`${APP_ORIGIN}/api/version`);
      await openerService.open("http:/api/version");
      await openerService.open("command:editor.action.selectAll", { allowCommands: true });
      expect(windowOpen.mock.calls.map(([url]) => url)).toEqual([link]);
    } finally {
      windowOpen.mockRestore();
      policy.dispose();
      happyDOM.setURL("about:blank");
    }
  });
});
