---
title: Browser
description: A full browser in every task and in Home, for the dev server, the PR and the docs, with bookmarks, DevTools, one sign-in shared by every task, and the option to be your default browser.
section: "In the code"
order: 5
---

Every task gets its own browser tabs. The dev server for this branch, the PR the agent just opened, the API docs you keep checking: they sit in the task's layout next to its code and terminals, and they stay with that task when you switch to another. Come back and they reopen on the pages they were showing.

Press `Cmd+Shift+B` to open a browser panel. Like any panel, it can go next to an agent's terminal, under your editor, or in a group of its own (see [Panel Layout](/docs/panel-layout)). From a terminal, `loxel <url>` opens a page in the task that terminal belongs to, and an agent with the [`loxel` skill](/docs/coding-agents#teach-your-agent-about-loxel) does the same to show you what it started.

An empty editor area lists what you can open, with a field next to **New Browser**: type a URL or a search and press `Enter` to open it in a new browser panel. As you type, bookmarks whose title or address match are suggested below it; pick one with the arrow keys and `Enter`, or click it.

---

## Home

**Home**, at the top of the worktree sidebar, is a place for browsing that belongs to no task. It's where Loxel opens when no worktree is selected, so it is also what a new window shows. Home has its own browser tabs and layout, kept across restarts like a task's, and when no tab is open it shows the same address field, with **Add Project** next to it. Editors, terminals and the Git panels belong to a worktree, so Home has browser panels only.

---

## Browsing

A browser panel is a full web view with back, forward, reload, an address bar, and DevTools. A new blank panel starts with the cursor in the address bar, so you can type a URL or a search right away. `Cmd+F` finds text in the page, and `Cmd+Shift+R` while the tab has focus does a hard refresh, reloading the page and bypassing the cache. Clicking the title of the active browser tab returns focus to its page.

Pages see the light or dark mode you choose in **Settings > Appearance > Theme**, not your Mac's: a site or dev server that follows the system appearance (`prefers-color-scheme`) shows its light colors in a light Loxel and its dark colors in a dark one. With **System**, they follow your Mac as Loxel does.

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

## Loxel as your default browser

Loxel can be your Mac's default web browser, so links you open in other apps, such as Slack, Mail or a terminal outside Loxel, open in a browser panel. Click **Set as default browser** in **Settings > General > Default Browser**, or choose Loxel under **System Settings > Desktop & Dock > Default web browser**; macOS asks you to confirm. Settings shows whether Loxel already is the default.

A link opens straight in a new browser panel, at the address you clicked: in the task the frontmost Loxel window shows, or in [Home](#home) when it shows none. A link that launches Loxel opens once the window is up. Loxel never becomes the default unless you choose it.

While Loxel is your default browser, what Loxel itself sends to your default browser opens in a browser panel too: **Open Link in External Browser** from a link's right-click menu, and a plain click on a URL in terminal output. To open a page in another browser, choose that browser as the default in System Settings.

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

You can also sign in with a passkey saved on your phone. When a site asks for a passkey your phone can provide, the browser panel that asked shows a QR code: scan it with your phone's camera and confirm on the phone. Bluetooth has to be on for both your Mac and your phone, because the phone checks that it is nearby, and the first time macOS asks to let Loxel use Bluetooth. **Hide QR code** only hides the code: the site still waits, so you can answer with Touch ID or a security key instead. When a site asks for a passkey that only a single device holds, such as one kept in this Mac's iCloud Keychain, no code appears and the site's other sign-in options still work.

---

## Page dialogs

When a page calls `alert()`, `confirm()`, or `prompt()`, the dialog opens over that page and names the site that asked. Only that browser panel waits for your answer; the rest of Loxel stays usable. `Enter` confirms and `Esc` cancels. Starting from a page's second dialog, you can check **Don't allow this page to show more dialogs** to silence it until it reloads or navigates. Reloading or navigating also dismisses any dialog that is open.

---

## See also

- [Panel Layout](/docs/panel-layout) — splitting, moving and maximizing browser panels like any other
- [Loxel CLI](/docs/cli#urls) — which task and window a `loxel <url>` page opens in
- [Keyboard Shortcuts](/docs/reference-keybindings) — browser shortcuts alongside the rest
