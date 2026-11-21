---
title: Browser
description: A full browser in every task and in Home, for the dev server, the PR and the docs, with bookmarks, DevTools, one sign-in shared by every task, and the option to be your default browser.
section: "In the code"
order: 5
---

Every task gets its own browser tabs. The dev server for this branch, the PR the agent just opened, the API docs you keep checking: they sit in the task's layout next to its code and terminals, and they keep running when you switch to another task. Come back and each page is exactly as you left it, down to the scroll position, the half-typed form and the sign-in in progress.

Press `Cmd+Shift+B` to open a browser panel. Like any panel, it can go next to an agent's terminal, under your editor, or in a group of its own (see [Panel Layout](/docs/panel-layout)). From a terminal, `loxel <url>` opens a page in the task that terminal belongs to, and an agent with the [`loxel` skill](/docs/coding-agents#teach-your-agent-about-loxel) does the same to show you what it started.

An empty editor area lists what you can open, with a field next to **New Browser**: type a URL or a search and press `Enter` to open it in a new browser panel. As you type, bookmarks whose title or address match are suggested below it; pick one with the arrow keys and `Enter`, or click it.

---

## Home

**Home**, at the top of the worktree sidebar, is where you browse outside any task. It's where Loxel opens when no worktree is selected, and it has its own browser tabs, kept across restarts, with the same address field when none is open. Terminals and plans can go there too; see [Worktrees & Tasks](/docs/worktrees-and-tasks#home).

---

## Tabs in other tasks

Browser tabs of the tasks you're not looking at, and of Home, keep running in the background. A CI run you left open keeps its place, a preview keeps its hot-reload state, and a page in another task can still [notify](#notifications) you when the build finishes or the deploy fails. Like a background tab in Chrome, a tab you can't see, in this task or another, knows it: sites that notify or play a sound only when you're away do so, and its animations pause and its timers slow down to save battery.

With dozens of tasks open, that adds up, so background tabs share a memory limit. Past it, the biggest tabs you haven't seen for longest are unloaded first, and an unloaded tab reloads on the page it was on when you come back to it. A background tab that keeps using CPU for minutes is paused until you come back. Tabs of sites you allowed to notify, and tabs with a notification waiting under the bell, are unloaded last and never paused, and pages on your own machine, such as a dev server, tabs playing sound and tabs with DevTools open are never paused either.

Choose how much background tabs may use in **Settings > Browser > Background Tabs**:

| Mode               | Memory limit             | Busy tabs pause after |
| ------------------ | ------------------------ | --------------------- |
| Save memory        | 10% of your Mac's memory | 1 minute              |
| Balanced (default) | 20%                      | 5 minutes             |
| Keep running       | 40%                      | Never                 |

---

## Browsing

A browser panel is a full web view with back, forward, reload, an address bar, and DevTools. A new blank panel starts with the cursor in the address bar, so you can type a URL or a search right away. `Cmd+F` finds text in the page, and `Cmd+Shift+R` while the tab has focus does a hard refresh, reloading the page and bypassing the cache. Clicking the title of the active browser tab returns focus to its page. A tab shows a spinner while its page loads, even in the background or in another task, and then the site's icon, kept up to date as the page changes it (an unread count, a build status).

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

Some sites, often company intranets, sign you in with a certificate from your keychain. A site never gets one silently: Loxel asks which certificate to use, listing each one's name, issuer and expiry, or lets you choose **Don't Use a Certificate**. When a page connects to a different site that asks for a certificate, the question names both. Your answer holds for that site until you quit Loxel. If you turn down a page's questions twice, it stops asking until the page navigates.

---

## Page dialogs

When a page calls `alert()`, `confirm()`, or `prompt()`, the dialog opens over that page and names the site that asked. Only that browser panel waits for your answer; the rest of Loxel stays usable. `Enter` confirms and `Esc` cancels. Starting from a page's second dialog, you can check **Don't allow this page to show more dialogs** to silence it until it reloads or navigates. Reloading or navigating also dismisses any dialog that is open.

---

## Downloads

When a page downloads a file, the download starts right away in your Downloads folder while Loxel asks where to save it, and once both are done Loxel moves the file where you chose. A file already in Downloads keeps its place: the download takes a numbered name beside it, such as `report (1).pdf`. Loxel replaces a file where you chose to save only when you confirmed replacing it in the dialog. Cancelling the dialog cancels the download, or deletes it if it already finished. While Loxel asks, further downloads from that page are cancelled, so a site can't pile up save dialogs. Every file you download is marked as downloaded from the internet, as files from Safari or Chrome are, from the moment it starts arriving, so macOS checks a downloaded app, script or installer when you first open it, even one whose download never finished.

---

## Site permissions

Pages in browser panels get what a browser gives every site without asking: copying to the clipboard when you click a copy button, fullscreen video, locking the pointer in games and 3D views, keeping the screen awake, and saving to files you pick. A site that wants your camera or microphone, to send notifications, to open a link in another app, or to reach your dev servers and devices on your network asks you first (see [Camera and microphone](#camera-and-microphone), [Other apps](#other-apps), [Local network](#local-network) and [Notifications](#notifications)). Everything else a browser would ask you about first is turned off, so sites can't use your location or read your clipboard; a site that asks is told no and can offer its usual fallback.

When a page goes full screen or hides your pointer, Loxel names the site at the top of the page for a few seconds, every time, and again when you come back, after a while away or from another app or window, to a page that is still full screen or still has your pointer, so a page can't pass itself off as Loxel or as your Mac asking for a password. Press Esc to leave full screen or get your pointer back. Whenever Loxel asks you something over a page (a site's request, the page's own alert, where to save a download) or opens Settings or another of its own dialogs, the page leaves full screen and gives your pointer back first, and gets neither again until you answer or close it, so the question is never hidden behind it. Click a video's full screen button meanwhile and Loxel points at the question waiting for your answer. Popup windows that sites open can't go full screen or hide your pointer.

### Camera and microphone

Video calls such as Google Meet work in a browser panel as they do in a browser. When a site first wants your camera or microphone, a bar under its address bar asks: **Allow** lets it use them on every visit, **Allow this time** lets it while the tab stays on the site, and **Block** turns it down for good. Close the bar to turn down just this request, so the site can ask again. A site that asks for the camera and then the microphone gets one question for both. Clicking a site's own button for your camera or microphone, such as Meet's **Use microphone and camera**, shows the same bar for just the devices that button is for. Only sites on `https` or on your own machine (such as `http://localhost`) can ask.

The first time a site you allowed uses one, macOS asks whether Loxel may use your camera or microphone. If Loxel's access is turned off in **System Settings > Privacy & Security**, the bar says so and opens the right pane; macOS may ask you to quit and reopen Loxel before the change applies.

Change a site's choice for each device, or remove it so the site asks again, in **Settings > Browser > Camera and Microphone**. A change applies the next time the site asks, such as when you join a call or reload the page.

### Other apps

Links meant for another app, such as a meeting link that opens Zoom or a `mailto:` link, ask before they open it: a bar under the address bar names the site and the app. **Allow** opens that site's links of that kind from then on, **Allow this time** opens just this one, and **Block** turns them down for good. Close the bar to turn down just this link. A link only opens another app right after you click or type in the page, even on a site you allowed, so no page can open an app as it loads. Ads and other frames embedded in a page can't open other apps, and popup windows only open links their site was allowed.

Change or remove a site's choices in **Settings > Browser > Other Apps**.

### Local network

Your dev servers stay private to your Mac: a site on the internet asks before it connects to apps on your Mac, such as a dev server or a local API, or to devices on your network, such as your router or printer. Pages on your Mac or your local network never ask, such as `http://localhost:3000`, `http://127.0.0.1:5173` or a dev server opened on your Mac's network address, so a dev server's page reaches its API, live reload and other local ports as before.

While the bar asks, the site's requests wait. **Allow** lets them through and lets the site connect from then on, **Allow this time** lets it while the tab stays on the site, and **Block** turns it down for good, which fails those requests. Close the bar to fail them for now: the site doesn't ask again until you reload or leave the page. Frames embedded in a page follow the page's choice, and a site's background workers ask in a tab showing the site.

Change or remove a site's choice in **Settings > Browser > Local Network**.

---

## Notifications

Pages can send notifications too, and they land in Loxel instead of on your desktop. The first time a site asks, a bar under its address bar offers **Allow** or **Block**; close the bar to decide later. An allowed site's notifications appear under the bell in the top bar with the site's icon, and a dot on its tab and on its task in the sidebar, so the dev server's build alert or a chat mention never pulls you out of Loxel. Click one to jump to its tab, and the page reacts as it would in a browser, opening the chat or build it was about. When a site sends several, they stack into one entry that shows the newest and how many more there are, kept apart per task, so a busy dev server never buries your agents' notifications. Click the stack to open the newest, click the count to see each one, or dismiss the whole stack at once.

Notifications come from every browser tab that is running, in any task or in Home (see [Tabs in other tasks](#tabs-in-other-tasks)), and, as in other browsers, from sites on `https` or on your own machine (such as `http://localhost`). Clicking one from another task takes you to that task first. A notification the page takes back stays under the bell until you've seen it. Change a site's choice, or remove it so the site asks again, in **Settings > Browser**.

Sites that notify from their service worker, as many web apps and PWAs do, work the same way while one of their tabs is open: the notification shows on the site's tab you used last, and clicking it lets the site do what it would in a browser, such as opening the page it was about in a new tab. Push messages, which reach a site while none of its tabs are open, aren't supported.

When a site gets chatty, right-click one of its notifications under the bell to **Snooze for 1 hour**, **Snooze until tomorrow** (9 AM), or **Mute until unmuted**. The site stays allowed, so its pages carry on as normal, but nothing it sends reaches the bell, its tab or its task until the snooze ends or you unmute it, from the same menu or in **Settings > Browser**.

---

## See also

- [Panel Layout](/docs/panel-layout) — splitting, moving and maximizing browser panels like any other
- [Loxel CLI](/docs/cli#urls) — which task and window a `loxel <url>` page opens in
- [Keyboard Shortcuts](/docs/reference-keybindings) — browser shortcuts alongside the rest
