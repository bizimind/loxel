# 0008 webContents.exitExclusiveAccess()

## What and why

Adds `webContents.exitExclusiveAccess()`, which ends what the user's Esc ends, at once: it takes the page out of HTML fullscreen and releases its pointer lock and keyboard lock (even when the page holds the Esc key, where Esc needs a press and hold). It does nothing when the page holds none of them, and leaves a window the user put in fullscreen as it is. An app that shows its own UI over a page, such as a permission prompt, had no way to do this, so a fullscreen page could cover the prompt and a locked pointer couldn't reach it.

The method first asks each frame's widget view to release pointer lock (`RenderWidgetHostView::UnlockPointer`: a frame's view acts only when its frame holds the lock, and a top-level view for any lock in its window), because Chromium's `PointerLockController` only resets its own state when a lock ends, and its `UnlockPointer` reaches only the main frame's widget. It then calls the WebContents' own `ExclusiveAccessManager::ExitExclusiveAccess()`, which reaches the same exits as Esc (`HandleUserKeyEvent` → `HandleUserPressedEscape`). That runs each controller's `ExitExclusiveAccessToPreviousState()`: the fullscreen controller exits tab fullscreen through `content::WebContents::ExitFullscreen`, which comes back through Electron's `ExitFullscreenModeForTab` and `SetHtmlApiFullscreen(false)`, so Electron's window and embedder state stay in step; the keyboard lock controller unlocks the keyboard.

For a `<webview>`, the guest's own `api::WebContents` is its delegate and holds the guest's fullscreen and pointer lock state (Chromium never grants keyboard lock to a guest), so the app calls the method on the guest's `webContents`. Electron mirrors the guest's HTML fullscreen onto the embedder, and exiting the guest's clears the embedder's too.

**Not used: `content::WebContents::ForSecurityDropFullscreen`.** It exits only contents whose delegate reports content fullscreen (`GetFullscreenState().target_mode == kContent`), and Electron's fullscreen controller reports windowed for a page in HTML fullscreen (its `tab_fullscreen_` is set on the usual path only inside a block Electron's Chromium patch disables, and otherwise only when the window was already fullscreen), so it would usually exit nothing, and it leaves pointer and keyboard lock alone. What it would add, a blocker that keeps the page from entering fullscreen again while held, this method doesn't: a page that still has a user gesture, or a fullscreen or pointer lock permission request already on its way, can enter again right after. An app showing UI over the page refuses the `fullscreen` and `pointerLock` permissions meanwhile; the API doc says so.

Loxel will call it on a browser panel's guest before showing a prompt over its page, feature-detecting it so dev runs on stock Electron keep working (issue #1563; a separate PR).

## Files

- Electron: `shell/browser/api/electron_api_web_contents.{h,cc}` (the method and its binding in `FillObjectTemplate`), `docs/api/web-contents.md` (the TypeScript definitions are generated from it), `spec/api-web-contents.spec.ts`.
- Chromium (read, not changed; Electron builds and patches them): `chrome/browser/ui/exclusive_access/exclusive_access_manager.cc` (`ExitExclusiveAccess`), `fullscreen_controller.cc` (`ExitExclusiveAccessToPreviousState`, `NotifyTabExclusiveAccessLost`), `pointer_lock_controller.cc`, `content/browser/renderer_host/render_widget_host_view_child_frame.cc` (`UnlockPointer`).

## Testing

- Electron specs: `e test --files spec/api-web-contents.spec.ts -g "exitExclusiveAccess"` on a testing build: a page in HTML fullscreen leaves it, a window the user put in fullscreen stays fullscreen, and a page holding nothing is left as it is.
- In Loxel, in a hidden demo: a browser panel page that entered fullscreen (`requestFullscreen()` from a click) leaves it when main calls `exitExclusiveAccess()` on its guest, the panel and window included, and calling it on a page that isn't fullscreen changes nothing. A page holding pointer lock (`requestPointerLock()`) gets `pointerlockchange` with `document.pointerLockElement` null.

## Rebase notes

`electron_api_web_contents.{h,cc}` change in every release; the method sits after `Focus()` (outside the non-Mac `IsFocused()` block, or macOS fails to link) and its binding after `isFocused`. Electron's patch to Chromium's exclusive access code (`patches/chromium/fix_adapt_exclusive_access_for_electron_needs.patch`) can change what `ExitExclusiveAccessToPreviousState` does; check that Esc and this method still take the same path.

## Upstream

A reasonable public PR to electron/electron; a description is drafted. Delete the patch once Electron ships an equivalent API, and switch Loxel's call to it.
