---
title: Browser
description: A full browser in every task, for the dev server, the PR and the docs, with bookmarks, DevTools, and one sign-in shared by every task.
section: "In the code"
order: 5
---

Every task gets its own browser tabs. The dev server for this branch, the PR the agent just opened, the API docs you keep checking: they sit in the task's layout next to its code and terminals, and they stay with that task when you switch to another. Come back and they reopen on the pages they were showing.

Press `Cmd+Shift+B` to open a browser panel. Like any panel, it can go next to an agent's terminal, under your editor, or in a group of its own (see [Panel Layout](/docs/panel-layout)). From a terminal, `loxel <url>` opens a page in the task that terminal belongs to, and an agent with the [`loxel` skill](/docs/coding-agents#teach-your-agent-about-loxel) does the same to show you what it started.

---

## Browsing

A browser panel is a full web view with back, forward, reload, an address bar, and DevTools. A new blank panel starts with the cursor in the address bar, so you can type a URL or a search right away. `Cmd+F` finds text in the page, and `Cmd+Shift+R` while the tab has focus does a hard refresh, reloading the page and bypassing the cache. Clicking the title of the active browser tab returns focus to its page.

---

## Bookmarks

Bookmark a page with the star at the end of the address bar, or `Cmd+D` while the tab has focus; the star fills in on a bookmarked page, and clicking it again removes the bookmark. The bookmark button next to the address bar lists your bookmarks, and a new blank tab shows them in place of an empty page. Click one to open it in the current tab, or `Cmd`-click or middle-click it to open it in a background tab (`Cmd+Shift`-click switches to it). Hover a bookmark and click its **×**, or press `Delete` on it in the list, to remove it. Bookmarks are shared by all your projects and windows and kept across restarts.

---

## Links, new tabs and popups

A plain click on a link opens it in the same tab. Links you open in a new tab or window become browser tabs right after the current one, in the same group:

- **`Cmd`-click or middle-click** opens the link in a background tab and keeps you on the current page, so you can hold `Cmd` and click several links in a row. The new tabs keep the order you clicked them in.
- **`Cmd+Shift`-click** opens the link in a new tab and switches to it.
- **Links that open a new window** (`target="_blank"`, or a page opening a window when you click something) open in a new tab and switch to it.
- **Popup windows** a page opens at a set size, such as a "Sign in with Google" window, open as a separate small window over Loxel, so the sign-in can finish and return to the page. The window's title shows the site it belongs to, and `Cmd+W` closes it.

Windows a page tries to open without you clicking or typing are blocked, and each click opens at most one tab or popup.

`Cmd`-clicking a URL in terminal output opens it in a browser panel too; a plain click opens it in your default browser.

---

## Right-click menu

Right-click in a page for a menu that matches what you clicked:

- **Link** — open it in a new tab (next to the current one, in the background), open it in your default browser, or copy its address.
- **Image** — open it in a new tab, save it, copy it, or copy its address.
- **Selected text** — copy it or search the web for it. In a text field you can also cut, paste and select all.
- **Page** — back, forward, reload, or view the page source in a new tab.

Every menu ends with **Inspect Element**, which opens DevTools on the element you clicked.

---

## Logins and passkeys

All browser panels share one persistent session, so cookies and logins carry across panels, tasks and restarts: sign in to GitHub once and every task's tabs are signed in. In the signed macOS app, sites can create and use passkeys with Touch ID.

---

## Page dialogs

When a page calls `alert()`, `confirm()`, or `prompt()`, the dialog opens over that page and names the site that asked. Only that browser panel waits for your answer; the rest of Loxel stays usable. `Enter` confirms and `Esc` cancels. Starting from a page's second dialog, you can check **Don't allow this page to show more dialogs** to silence it until it reloads or navigates. Reloading or navigating also dismisses any dialog that is open.

---

## See also

- [Panel Layout](/docs/panel-layout) — splitting, moving and maximizing browser panels like any other
- [Loxel CLI](/docs/cli#urls) — which task and window a `loxel <url>` page opens in
- [Keyboard Shortcuts](/docs/reference-keybindings) — browser shortcuts alongside the rest
