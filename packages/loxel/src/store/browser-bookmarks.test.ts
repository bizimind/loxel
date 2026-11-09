import { beforeEach, describe, expect, jest, test } from "bun:test";

import { parseBookmarks, useBrowserBookmarksStore } from "./browser-bookmarks";
import { applyStoreUpdate } from "./store-sync";

const DOCS = { url: "https://example.com/docs", title: "Docs" };

beforeEach(() => useBrowserBookmarksStore.setState({ bookmarks: [] }));

describe("browser bookmarks", () => {
  test("toggling adds a page at the end and removes it again", () => {
    const { toggleBookmark } = useBrowserBookmarksStore.getState();
    const blog = {
      url: "https://blog.example.com/",
      title: "Blog",
      faviconUrl: "https://blog.example.com/x.ico",
    };
    toggleBookmark(DOCS);
    toggleBookmark(blog);
    expect(useBrowserBookmarksStore.getState().bookmarks).toEqual([DOCS, blog]);
    toggleBookmark({ ...DOCS, title: "Other title" });
    expect(useBrowserBookmarksStore.getState().bookmarks).toEqual([blog]);
  });

  test("parsing keeps valid entries, dropping malformed ones and repeated URLs", () => {
    expect(parseBookmarks(undefined)).toEqual([]);
    expect(parseBookmarks({ bookmarks: "nope" })).toEqual([]);
    expect(
      parseBookmarks({
        bookmarks: [DOCS, { url: 1, title: "bad" }, null, { ...DOCS, title: "again" }],
      }),
    ).toEqual([DOCS]);
  });

  test("keeps web pages only, capping the title and dropping a favicon it can't keep", () => {
    const { toggleBookmark } = useBrowserBookmarksStore.getState();
    toggleBookmark({ url: "file:///etc/hosts", title: "hosts" });
    toggleBookmark({ url: "javascript:alert(1)", title: "x" });
    toggleBookmark({ url: "https://a.example/", title: "t".repeat(1000), faviconUrl: "file:///x" });
    toggleBookmark({
      url: "https://b.example/",
      title: "B",
      faviconUrl: "data:image/png;base64,AA",
    });
    const [a, b, ...rest] = useBrowserBookmarksStore.getState().bookmarks;
    expect(rest).toEqual([]);
    expect(a?.url).toBe("https://a.example/");
    expect(a?.title).toHaveLength(300);
    expect(a?.faviconUrl).toBeUndefined();
    expect(b?.faviconUrl).toBe("data:image/png;base64,AA");
    expect(
      parseBookmarks({ bookmarks: [{ url: "chrome://settings", title: "Settings" }, DOCS] }),
    ).toEqual([DOCS]);
  });

  test("another window's update applies, and an echo of the current list is a no-op", () => {
    applyStoreUpdate("browser-bookmarks", { bookmarks: [DOCS, { url: 5 }] });
    expect(useBrowserBookmarksStore.getState().bookmarks).toEqual([DOCS]);
    // Entries whose favicon was dropped, or never there, must round-trip to the same keys.
    useBrowserBookmarksStore.getState().toggleBookmark({ ...DOCS, url: "https://c.example/" });
    useBrowserBookmarksStore
      .getState()
      .toggleBookmark({ url: "https://d.example/", title: "D", faviconUrl: "file:///x" });

    const { partialize } = useBrowserBookmarksStore.persist.getOptions();
    const persisted = partialize?.(useBrowserBookmarksStore.getState());
    const listener = jest.fn();
    const unsubscribe = useBrowserBookmarksStore.subscribe(listener);
    applyStoreUpdate("browser-bookmarks", JSON.parse(JSON.stringify(persisted)));
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });
});
