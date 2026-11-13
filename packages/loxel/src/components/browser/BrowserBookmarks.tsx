import { BookmarkIcon, StarIcon, XIcon } from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";
import { flushSync } from "react-dom";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { KeyBindingDisplay } from "@/components/ui/key-binding-display";
import { cn } from "@/lib/utils";
import { type BrowserBookmark, useBrowserBookmarksStore } from "@/store/browser-bookmarks";
import { getBindingsForAction, useKeybindingStore } from "@/store/keybindings/keybinding-store";

import { Favicon } from "./Favicon";

/**
 * Open a bookmark as a link would open: a plain click in this tab, `Cmd`-click or middle-click in
 * a new background tab, and `Cmd+Shift`-click in a new tab switched to.
 */
export type OpenBookmark = (url: string, inNewTab: { activate: boolean } | null) => void;

function newTabFor(event: MouseEvent): { activate: boolean } | null {
  if (event.button === 1 || event.metaKey) return { activate: event.shiftKey };
  return null;
}

/** The star at the end of the address bar, filled while the page is bookmarked. */
export function BookmarkToggle({
  bookmarked,
  disabled,
  onToggle,
}: {
  bookmarked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      title={bookmarked ? "Remove Bookmark" : "Bookmark This Page"}
      aria-pressed={bookmarked}
      className="text-muted-foreground hover:text-foreground flex size-4 shrink-0 cursor-pointer items-center justify-center rounded disabled:cursor-default disabled:opacity-0"
    >
      <StarIcon className={cn("size-3", bookmarked && "fill-amber-400 text-amber-400")} />
    </button>
  );
}

/** The shortcut that bookmarks a page, if one is bound. */
function BookmarkShortcut() {
  const binding = getBindingsForAction(useKeybindingStore(), "browser.toggleBookmark")[0];
  if (!binding) return null;
  return <KeyBindingDisplay binding={binding} className="mx-0.5 align-[-0.15em]" />;
}

function EmptyHint() {
  return (
    <>
      Bookmark a page with the star in the address bar or <BookmarkShortcut />.
    </>
  );
}

/** The toolbar button listing the bookmarks. */
export function BookmarksMenu({ onOpen }: { onOpen: OpenBookmark }) {
  const bookmarks = useBrowserBookmarksStore((s) => s.bookmarks);
  const removeBookmark = useBrowserBookmarksStore((s) => s.removeBookmark);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title="Bookmarks"
        className="text-muted-foreground hover:text-foreground hover:bg-muted data-popup-open:bg-muted data-popup-open:text-foreground flex size-6 cursor-pointer items-center justify-center rounded transition-colors"
      >
        <BookmarkIcon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 max-w-[80vw]">
        {bookmarks.length === 0 ? (
          <p className="text-muted-foreground px-2 py-1.5 text-xs">
            <EmptyHint />
          </p>
        ) : (
          bookmarks.map((bookmark) => (
            <DropdownMenuItem
              key={bookmark.url}
              title={bookmark.url}
              onClick={(event) => onOpen(bookmark.url, newTabFor(event))}
              onAuxClick={(event) => {
                if (event.button === 1) onOpen(bookmark.url, newTabFor(event));
              }}
              onKeyDown={(event) => {
                if (event.key === "Delete" || event.key === "Backspace") {
                  removeFocusedRow(event, () => removeBookmark(bookmark.url));
                }
              }}
              className="group/bookmark"
            >
              <Favicon url={bookmark.faviconUrl} />
              <span className="min-w-0 flex-1 truncate">{bookmark.title || bookmark.url}</span>
              <RemoveButton bookmark={bookmark} tabIndex={-1} className="-mr-1" />
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Remove the focused menu row, moving focus to the row after it (or before it, or the menu): a
 * focused element that leaves the page drops focus to the body, out of the menu's arrow keys.
 */
function removeFocusedRow(event: KeyboardEvent<HTMLElement>, remove: () => void) {
  const row = event.currentTarget;
  const next =
    (row.nextElementSibling as HTMLElement | null) ??
    (row.previousElementSibling as HTMLElement | null) ??
    row.closest<HTMLElement>('[role="menu"]');
  // Rendered before focusing, so the menu knows the rows' new positions.
  flushSync(remove);
  next?.focus();
}

/** Removes a bookmark from inside a clickable row, without opening it. Shown on hover. */
function RemoveButton({
  bookmark,
  tabIndex,
  className,
}: {
  bookmark: BrowserBookmark;
  /** -1 inside the menu, whose arrow keys move between rows. */
  tabIndex?: number;
  className?: string;
}) {
  const removeBookmark = useBrowserBookmarksStore((s) => s.removeBookmark);
  return (
    <button
      type="button"
      tabIndex={tabIndex}
      aria-label={`Remove bookmark ${bookmark.title || bookmark.url}`}
      title="Remove Bookmark"
      onClick={(event) => {
        // The row would open the bookmark (and close the menu).
        event.stopPropagation();
        removeBookmark(bookmark.url);
      }}
      onAuxClick={(event) => event.stopPropagation()}
      className={cn(
        "text-muted-foreground hover:text-foreground flex size-5 shrink-0 cursor-pointer items-center justify-center rounded opacity-0 group-hover/bookmark:opacity-100 focus-visible:opacity-100",
        className,
      )}
    >
      <XIcon className="size-3" />
    </button>
  );
}

/** A URL's host, to tell bookmarks with like titles apart; the URL itself if it has none. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** What a blank browser tab shows over its empty page: the bookmarks, to open one. */
export function BookmarksStartPage({ onOpen }: { onOpen: OpenBookmark }) {
  const bookmarks = useBrowserBookmarksStore((s) => s.bookmarks);

  return (
    <div className="bg-editor-surface absolute inset-0 overflow-y-auto p-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Bookmarks
        </h2>
        {bookmarks.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            <EmptyHint />
          </p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-2">
            {bookmarks.map((bookmark) => (
              <li key={bookmark.url} className="group/bookmark relative">
                <button
                  type="button"
                  title={bookmark.url}
                  onClick={(event) => onOpen(bookmark.url, newTabFor(event))}
                  onAuxClick={(event) => {
                    if (event.button === 1) onOpen(bookmark.url, newTabFor(event));
                  }}
                  className="border-border hover:bg-muted flex w-full cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 pr-8 text-left transition-colors"
                >
                  <Favicon url={bookmark.faviconUrl} className="size-4" />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-foreground truncate text-xs">
                      {bookmark.title || bookmark.url}
                    </span>
                    <span className="text-muted-foreground truncate text-[11px]">
                      {hostOf(bookmark.url)}
                    </span>
                  </span>
                </button>
                <RemoveButton
                  bookmark={bookmark}
                  className="absolute top-1/2 right-1.5 -translate-y-1/2"
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
