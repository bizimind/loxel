import { z } from "zod";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { STORAGE_PREFIX } from "@/lib/env";
import { isHttpUrl } from "@/url-utils";

import { serverBrowserBookmarksStorage } from "./server-storage";

/** Longest title kept: the whole list is written, and sent to every window, on each change. */
const MAX_TITLE_LENGTH = 300;
/** Largest inline (`data:`) favicon kept, for the same reason. */
const MAX_DATA_FAVICON_LENGTH = 16 * 1024;

function isStorableFavicon(url: string): boolean {
  if (url.startsWith("data:image/")) return url.length <= MAX_DATA_FAVICON_LENGTH;
  return isHttpUrl(url);
}

/**
 * One rule for bookmarks added here and those read from storage or another window: web pages
 * only, since a bookmark can open straight into a new tab, with a capped title and favicon.
 */
const bookmarkSchema = z
  .object({
    url: z.string().refine(isHttpUrl),
    title: z.string().transform((title) => title.slice(0, MAX_TITLE_LENGTH)),
    faviconUrl: z.unknown().optional(),
  })
  .transform(({ url, title, faviconUrl }): { url: string; title: string; faviconUrl?: string } =>
    // A favicon that can't be kept is dropped, not the bookmark. Without the key, not set to
    // undefined: JSON drops such keys, and the windows' copies must stay key-for-key equal (see
    // `reconcile`) or each would write the list back to the other.
    typeof faviconUrl === "string" && isStorableFavicon(faviconUrl)
      ? { url, title, faviconUrl }
      : { url, title },
  );

/** A page saved from a browser panel. Its URL identifies it: a page is bookmarked at most once. */
export type BrowserBookmark = z.infer<typeof bookmarkSchema>;

/**
 * The persisted bookmarks in `raw` (a stored or synced state), dropping malformed entries and
 * repeated URLs rather than the whole list.
 */
export function parseBookmarks(raw: unknown): BrowserBookmark[] {
  const list = z.object({ bookmarks: z.array(z.unknown()) }).safeParse(raw);
  if (!list.success) return [];
  const seen = new Set<string>();
  const bookmarks: BrowserBookmark[] = [];
  for (const entry of list.data.bookmarks) {
    const bookmark = bookmarkSchema.safeParse(entry);
    if (!bookmark.success || seen.has(bookmark.data.url)) continue;
    seen.add(bookmark.data.url);
    bookmarks.push(bookmark.data);
  }
  return bookmarks;
}

interface PersistedBookmarks {
  bookmarks: BrowserBookmark[];
}

interface BrowserBookmarksState extends PersistedBookmarks {
  /**
   * Bookmark `page` at the end of the list, or remove its bookmark if it has one. A page that is
   * not on the web is ignored.
   */
  toggleBookmark: (page: BrowserBookmark) => void;
  removeBookmark: (url: string) => void;
}

/** Bookmarks of browser panel pages, shared by every project, worktree and window. */
export const useBrowserBookmarksStore = create<BrowserBookmarksState>()(
  persist(
    (set) => ({
      bookmarks: [],
      toggleBookmark: (page) =>
        set(({ bookmarks }) => {
          if (bookmarks.some((b) => b.url === page.url)) {
            return { bookmarks: bookmarks.filter((b) => b.url !== page.url) };
          }
          const bookmark = bookmarkSchema.safeParse(page);
          return bookmark.success ? { bookmarks: [...bookmarks, bookmark.data] } : {};
        }),
      removeBookmark: (url) =>
        set(({ bookmarks }) => ({ bookmarks: bookmarks.filter((b) => b.url !== url) })),
    }),
    {
      name: `${STORAGE_PREFIX}-browser-bookmarks`,
      storage: createJSONStorage(() => serverBrowserBookmarksStorage),
      partialize: (state): PersistedBookmarks => ({ bookmarks: state.bookmarks }),
      merge: (persisted, current) => ({ ...current, bookmarks: parseBookmarks(persisted) }),
    },
  ),
);

/** Whether `url` is bookmarked. */
export function useIsBookmarked(url: string): boolean {
  return useBrowserBookmarksStore((s) => s.bookmarks.some((b) => b.url === url));
}

/**
 * The bookmarks whose title or URL contains `query` (ignoring case), at most `limit`, in list
 * order: the suggestions for a typed address. None for a blank query.
 */
export function matchBookmarks(
  bookmarks: readonly BrowserBookmark[],
  query: string,
  limit: number,
): BrowserBookmark[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return bookmarks
    .filter((b) => b.title.toLowerCase().includes(needle) || b.url.toLowerCase().includes(needle))
    .slice(0, limit);
}
