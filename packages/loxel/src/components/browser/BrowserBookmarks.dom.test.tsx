import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { useBrowserBookmarksStore } from "@/store/browser-bookmarks";

import { BookmarksMenu, BookmarksStartPage } from "./BrowserBookmarks";

const DOCS = { url: "https://example.com/docs", title: "Docs" };
const BLOG = { url: "https://blog.example.com/", title: "" };

beforeEach(() => useBrowserBookmarksStore.setState({ bookmarks: [DOCS, BLOG] }));
afterEach(cleanup);

describe("bookmarks start page", () => {
  test("lists bookmarks in order, by title or else URL, with their host", () => {
    render(<BookmarksStartPage onOpen={() => {}} />);
    const tiles = screen.getAllByRole("button", { name: /^(?!Remove)/ });
    expect(tiles.map((tile) => tile.textContent)).toEqual([
      "Docsexample.com",
      "https://blog.example.com/blog.example.com",
    ]);
  });

  test("opens a bookmark here on a click, and in a new tab like a link would", () => {
    const onOpen = mock();
    render(<BookmarksStartPage onOpen={onOpen} />);
    const tile = screen.getByRole("button", { name: /^Docs/ });

    fireEvent.click(tile);
    fireEvent.click(tile, { metaKey: true });
    fireEvent.click(tile, { metaKey: true, shiftKey: true });
    fireEvent(tile, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(onOpen.mock.calls).toEqual([
      [DOCS.url, null],
      [DOCS.url, { activate: false }],
      [DOCS.url, { activate: true }],
      [DOCS.url, { activate: false }],
    ]);
  });

  test("removes a bookmark without opening it", () => {
    const onOpen = mock();
    render(<BookmarksStartPage onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove bookmark Docs" }));
    expect(useBrowserBookmarksStore.getState().bookmarks).toEqual([BLOG]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  test("says how to bookmark a page while there are none", () => {
    act(() => useBrowserBookmarksStore.setState({ bookmarks: [] }));
    render(<BookmarksStartPage onOpen={() => {}} />);
    expect(screen.getByText(/Bookmark a page with the star/)).toBeInTheDocument();
  });
});

describe("bookmarks menu", () => {
  test("Delete keeps focus in the menu, on the next row", async () => {
    openMenu();
    const docs = await screen.findByRole("menuitem", { name: /^Docs/ });
    docs.focus();
    fireEvent.keyDown(docs, { key: "Delete" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /blog/ }));
    fireEvent.keyDown(document.activeElement!, { key: "Backspace" });
    expect(document.activeElement).toBe(screen.getByRole("menu"));
  });

  function openMenu(onOpen = mock()) {
    render(<BookmarksMenu onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "Bookmarks" }));
    return onOpen;
  }

  test("opens a bookmark and closes", async () => {
    const onOpen = openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Docs/ }));
    expect(onOpen.mock.calls).toEqual([[DOCS.url, null]]);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  test("removes a bookmark with its button or Delete, keeping the menu open", async () => {
    const onOpen = openMenu();
    fireEvent.click(await screen.findByRole("button", { name: "Remove bookmark Docs" }));
    expect(useBrowserBookmarksStore.getState().bookmarks).toEqual([BLOG]);
    const blog = screen.getByRole("menuitem", { name: /blog\.example\.com/ });
    fireEvent.keyDown(blog, { key: "Delete" });
    expect(useBrowserBookmarksStore.getState().bookmarks).toEqual([]);
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByText(/Bookmark a page with the star/)).toBeInTheDocument();
  });
});
