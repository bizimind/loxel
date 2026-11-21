import { describe, expect, mock, test } from "bun:test";

import * as monaco from "monaco-editor";

import { createLinkOpener } from "./link-opener";

const APP_ORIGIN = "http://127.0.0.1:7433";

function open(link: string) {
  const openExternal = mock();
  const handled = createLinkOpener(APP_ORIGIN, openExternal).open(monaco.Uri.parse(link));
  return { handled, opened: openExternal.mock.calls.map(([url]) => url) };
}

describe("createLinkOpener", () => {
  test("opens web links in the browser", () => {
    expect(open("https://example.com/docs?q=a%20b#top")).toEqual({
      handled: true,
      opened: ["https://example.com/docs?q=a%20b#top"],
    });
    expect(open("http://localhost:3000/").opened).toEqual(["http://localhost:3000/"]);
  });

  test("does not open links to the app's own origin", () => {
    expect(open(`${APP_ORIGIN}/api/version`)).toEqual({ handled: true, opened: [] });
    expect(open(`${APP_ORIGIN}/`)).toEqual({ handled: true, opened: [] });
  });

  test("takes command: links without running them", () => {
    expect(open("command:editor.action.selectAll")).toEqual({ handled: true, opened: [] });
    expect(open("COMMAND:editor.action.selectAll?%5B%5D")).toEqual({ handled: true, opened: [] });
  });

  test("leaves file and editor links to the editor opener", () => {
    expect(open("file:///repo/src/main.ts")).toEqual({ handled: false, opened: [] });
    expect(open("loxel://server/repo/main.ts")).toEqual({ handled: false, opened: [] });
  });
});
