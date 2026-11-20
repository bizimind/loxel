# 0008 webContents.exitExclusiveAccess()

## What and why

Adds `webContents.exitExclusiveAccess()`, which does what the user's Esc does: it takes the page out of HTML fullscreen and releases its pointer lock and keyboard lock, and does nothing when the page holds none of them. An app that shows its own UI over a page, such as a permission prompt, had no way to do this, so a fullscreen page could cover the prompt and a locked pointer couldn't reach it.

The method first asks each frame's widget view to release pointer lock (`RenderWidgetHostView::UnlockPointer`, which acts only for the frame that holds it), because Electron's `PointerLockController` only resets its own state when a lock ends, and its `UnlockPointer` reaches only the main frame's widget. It then calls the WebContents' own `ExclusiveAccessManager::ExitExclusiveAccess()`, the Esc path in `PreHandleKeyboardEvent`. That runs each controller's `ExitExclusiveAccessToPreviousState()`: the fullscreen controller exits tab fullscreen through `content::WebContents::ExitFullscreen`, which comes back through Electron's `ExitFullscreenModeForTab` and `SetHtmlApiFullscreen(false)`, so Electron's window and embedder state stay in step; the keyboard lock controller unlocks the keyboard.

For a `<webview>`, the guest's own `api::WebContents` is its delegate and holds the guest's fullscreen and locks, so the app calls the method on the guest's `webContents`. Electron mirrors the guest's HTML fullscreen onto the embedder, and exiting the guest's clears the embedder's too.

**Not used: `content::WebContents::ForSecurityDropFullscreen`.** It also exits fullscreen in openers and the outer embedder chain, by calling `ExitFullscreen` on each of them directly. For a guest that means exiting the embedder's mirrored fullscreen behind the guest's back: the embedder's `SetHtmlApiFullscreen(false)` resets the guest's `html_fullscreen_` flag, but the guest's fullscreen controller still has the guest as its fullscreen tab, so the two disagree until the page next changes fullscreen. Exiting from the guest, where the state lives, keeps them together, and an app that needs openers out of fullscreen can call the method on them too.

Loxel will call it on a browser panel's guest before showing a prompt over its page, feature-detecting it so dev runs on stock Electron keep working (issue #1563; a separate PR).

## Files

- Electron: `shell/browser/api/electron_api_web_contents.{h,cc}` (the method and its binding in `FillObjectTemplate`), `docs/api/web-contents.md` (the TypeScript definitions are generated from it), `spec/api-web-contents.spec.ts`.
- Chromium (read, not changed; Electron builds and patches them): `chrome/browser/ui/exclusive_access/exclusive_access_manager.cc` (`ExitExclusiveAccess`), `fullscreen_controller.cc` (`ExitExclusiveAccessToPreviousState`, `NotifyTabExclusiveAccessLost`), `pointer_lock_controller.cc`, `content/browser/renderer_host/render_widget_host_view_child_frame.cc` (`UnlockPointer`).

## Testing

- Electron specs: `e test --files spec/api-web-contents.spec.ts -g "exitExclusiveAccess"` on a testing build: a page in HTML fullscreen leaves it, and a page holding nothing is left as it is.
- In Loxel, in a hidden demo: a browser panel page that entered fullscreen (`requestFullscreen()` from a click) leaves it when main calls `exitExclusiveAccess()` on its guest, the panel and window included, and calling it on a page that isn't fullscreen changes nothing. A page holding pointer lock (`requestPointerLock()`) gets `pointerlockchange` with `document.pointerLockElement` null.

## Rebase notes

`electron_api_web_contents.{h,cc}` change in every release; the method sits after `IsFocused` and its binding after `isFocused`. Electron's patch to Chromium's exclusive access code (`patches/chromium/fix_adapt_exclusive_access_for_electron_needs.patch`) can change what `ExitExclusiveAccessToPreviousState` does; check that Esc and this method still take the same path.

## Upstream

A reasonable public PR to electron/electron; a description is drafted. Delete the patch once Electron ships an equivalent API, and switch Loxel's call to it.
