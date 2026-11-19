import type { DockviewPanelApi } from "dockview-react";
import type {
  DidFailLoadEvent,
  DidNavigateEvent,
  DidNavigateInPageEvent,
  DidStartNavigationEvent,
  ContextMenuEvent,
  FoundInPageEvent,
  PageFaviconUpdatedEvent,
  PageTitleUpdatedEvent,
  WebviewTag,
} from "electron";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  BugIcon,
  GlobeIcon,
  LoaderIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { FindBar } from "@/components/ui/find-bar";
import { BROWSER_PARTITION } from "@/electron/browser-partition";
import { isActivatedPanel, usePanelActivationFocus } from "@/hooks/usePanelActivationFocus";
import { usePanelFind } from "@/hooks/usePanelFind";
import { registerBrowserPanelTarget } from "@/lib/browser-panel-targets";
import { openBrowserTab } from "@/lib/panel-creators";
import { cn } from "@/lib/utils";
import {
  type BrowserBookmark,
  useBrowserBookmarksStore,
  useIsBookmarked,
} from "@/store/browser-bookmarks";
import {
  setBrowserPageLoading,
  setBrowserPageUrl,
  setBrowserPageWebContents,
} from "@/store/browser-pages";
import { isHttpUrl, isSameOrigin } from "@/url-utils";

import {
  BookmarksMenu,
  BookmarksStartPage,
  BookmarkToggle,
  type OpenBookmark,
} from "./BrowserBookmarks";
import { BrowserContextMenu, type BrowserContextMenuState } from "./BrowserContextMenu";
import { faviconCandidates, pickFavicon } from "./favicon-loads";
import { JavaScriptDialog } from "./JavaScriptDialog";
import { MediaPermissionBar, MediaSystemBlockedBar } from "./MediaPermissionBar";
import { NotificationPermissionBar } from "./NotificationPermissionBar";
import { PasskeyQrOverlay } from "./PasskeyQrOverlay";
import { useBrowserMediaPermissions } from "./useBrowserMediaPermissions";
import { useBrowserNotifications } from "./useBrowserNotifications";
import { useJavaScriptDialogs } from "./useJavaScriptDialogs";
import { addressBarUrl } from "./web-search";

const isElectron = navigator.userAgent.includes("Electron");

/**
 * Let pages ask for new tabs and windows (⌘-click, middle-click, `target="_blank"`,
 * `window.open`), which the main process turns into browser tabs. Passed as a string: React drops `true` for attributes it does not know, though @types/react
 * types this one as a boolean.
 */
const popupAttributes: Record<string, string> = window.electronAPI ? { allowpopups: "" } : {};

/** Whether `url` is the empty page a new browser panel opens on. */
function isBlankPage(url: string): boolean {
  return !url || url === "about:blank";
}

export interface BrowserPanelParams {
  url: string;
  faviconUrl?: string;
}

interface BrowserPanelProps {
  url: string;
  /** The browser panel's dockview id. */
  panelId: string;
  /**
   * The browser panel while its layout is shown. Null while the page runs in the background (see
   * `store/browser-pages.ts`): the page keeps its own state, and its panel catches up when shown.
   */
  panelApi: DockviewPanelApi | null;
  /** The worktree whose layout the panel is in, or null for Home's. */
  worktreePath: string | null;
  /**
   * How many times the page was resumed from a freeze (see `store/browser-pages.ts`). Chromium
   * leaves a resumed page hidden, so each one hides the webview for a frame to show it again.
   */
  resumes?: number;
}

export function BrowserPanel({
  url: initialUrl,
  panelId,
  panelApi,
  worktreePath,
  resumes = 0,
}: BrowserPanelProps) {
  const webviewRef = useRef<WebviewTag | null>(null);
  const readyRef = useRef(false);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [inputUrl, setInputUrl] = useState(initialUrl);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<BrowserContextMenuState | null>(null);
  const [webContentsId, setWebContentsId] = useState<number | null>(null);
  useEffect(() => {
    const webview = webviewRef.current;
    if (resumes === 0 || !webview) return;
    webview.style.visibility = "hidden";
    const frame = requestAnimationFrame(() => {
      webview.style.visibility = "";
    });
    return () => {
      cancelAnimationFrame(frame);
      webview.style.visibility = "";
    };
  }, [resumes]);

  // The pool measures and freezes the page by its guest.
  useEffect(() => {
    if (webContentsId !== null) setBrowserPageWebContents(panelId, webContentsId);
  }, [panelId, webContentsId]);
  const urlInputRef = useRef<HTMLInputElement>(null);
  // The page shown or loading, for the activation focus, which runs outside render.
  const currentUrlRef = useRef(currentUrl);
  useEffect(() => {
    currentUrlRef.current = currentUrl;
  }, [currentUrl]);
  // The page that committed, which a bookmark saves: the address bar and the panel title run ahead
  // of it while the next page loads, and the title and favicon arrive after it commits. Its URL is
  // empty while there is none, or after a load failed.
  const pageRef = useRef<BrowserBookmark>({ url: "", title: "" });
  // Counts the page's favicon changes, so a `blob:` favicon read after a newer one arrived is dropped.
  const faviconRequestRef = useRef(0);
  const [pageUrl, setPageUrl] = useState("");
  const isBookmarked = useIsBookmarked(pageUrl);

  // The panel for the page's events, which outlive any one panel API (the layout is rebuilt on
  // every worktree switch).
  const panelApiRef = useRef(panelApi);
  // In the commit that detaches the page, before its events can reach the old layout's panel.
  useLayoutEffect(() => {
    panelApiRef.current = panelApi;
  }, [panelApi]);
  useEffect(() => {
    // Shown again after running in the background: give the panel the page's tab and params.
    const page = pageRef.current;
    if (!panelApi || !page.url) return;
    panelApi.updateParameters({ url: page.url, faviconUrl: page.faviconUrl });
    if (page.title) panelApi.setTitle(page.title);
  }, [panelApi]);

  // The page's alert() / confirm() / prompt(), shown over the page one at a time.
  // Navigating from the toolbar first dismisses them: the navigation would wait for the page.
  const {
    dialog,
    answer: answerDialog,
    dismissAll: dismissDialogs,
  } = useJavaScriptDialogs(webContentsId);
  const dialogFocusRef = useRef<HTMLElement | null>(null);

  // The page's web notifications go to the notification center, with its favicon; a site asking
  // to show them gets a bar under the toolbar.
  const { request: notificationRequest, answer: answerNotificationRequest } =
    useBrowserNotifications(webContentsId, panelId, worktreePath, pageRef);
  // A site asking for the camera or microphone gets a bar under the toolbar too.
  const {
    request: mediaRequest,
    answer: answerMediaRequest,
    systemBlocked: mediaSystemBlocked,
    dismissSystemBlocked: dismissMediaSystemBlocked,
  } = useBrowserMediaPermissions(webContentsId);

  // Find in page (⌘F) with Chromium's native search: highlights, scrolling and match counts.
  const rootRef = useRef<HTMLDivElement>(null);
  const findRequestRef = useRef(0);
  // Set when the page changed (or wasn't ready) since the last search: the next step must start a
  // new find session, since Chromium's session belongs to the previous document.
  const findSessionStaleRef = useRef(true);
  const { barProps: findBarProps, setMatches: setFindMatches } = usePanelFind(rootRef, {
    find: (query, direction, newQuery) => {
      const webview = webviewRef.current;
      if (!webview || !readyRef.current) return;
      findRequestRef.current = webview.findInPage(query, {
        forward: direction === "next",
        findNext: newQuery || findSessionStaleRef.current,
      });
      findSessionStaleRef.current = false;
    },
    clear: () => {
      if (readyRef.current) webviewRef.current?.stopFindInPage("clearSelection");
    },
    close: () => {
      const webview = webviewRef.current;
      if (!webview || !readyRef.current) return;
      // Leave the active match selected, like Chrome's find bar.
      webview.stopFindInPage("keepSelection");
      webview.focus();
    },
  });

  // Hand keyboard focus to the page when the panel is activated (e.g. directional focus), or to
  // the address bar while the panel shows no page yet, so a new blank tab is ready for a URL.
  // Skip when focus is already inside the panel so clicking the URL bar keeps its focus.
  usePanelActivationFocus(
    panelApi,
    useCallback(() => {
      const webview = webviewRef.current;
      if (!webview || rootRef.current?.contains(document.activeElement)) return;
      const page = isBlankPage(currentUrlRef.current) ? urlInputRef.current : webview;
      const target = dialogFocusRef.current ?? page;
      if (!target) return;
      target.focus();
      // A tab switched to is unhidden a frame later (dockview's overlay for "always"-rendered
      // panels), and its hidden elements can't take focus until then. The webview can.
      if (document.activeElement === target) return;
      requestAnimationFrame(() => {
        const api = panelApiRef.current;
        if (api && isActivatedPanel(api) && !rootRef.current?.contains(document.activeElement)) {
          target.focus();
        }
      });
    }, []),
  );

  // Links the page opens in a new tab or window (⌘-click, middle-click, target="_blank", window.open).
  useEffect(
    () =>
      window.electronAPI?.onOpenInNewBrowserTab((webContentsId, url, background) => {
        const webview = webviewRef.current;
        if (!webview || !readyRef.current || webContentsId !== webview.getWebContentsId()) return;
        // Tabs open next to the panel, in the layout shown; not from a page in the background.
        if (!panelApiRef.current) return;
        openBrowserTab(url, { sourcePanelId: panelId, activate: !background });
      }),
    [panelId],
  );

  // Attach webview event listeners
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const onDomReady = () => {
      // Every dom-ready: a webview re-attached to the DOM gets a new guest.
      setWebContentsId(webview.getWebContentsId());
      if (!readyRef.current) {
        readyRef.current = true;
        if (!isBlankPage(initialUrl)) {
          loadUrl(webview, initialUrl);
        }
      }
    };
    webview.addEventListener("dom-ready", onDomReady);

    function updateNavState() {
      if (!webview || !readyRef.current) return;
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
    }

    const onStartLoading = () => {
      setIsLoading(true);
      setLoadError(null);
    };

    // The tab's spinner, as browsers show it: from the start of a navigation to a new document of
    // the page itself (not of a frame in it, nor in-page) until everything the page loads is done.
    const onStartNavigation = (event: DidStartNavigationEvent) => {
      if (event.isMainFrame && !event.isInPlace) setBrowserPageLoading(panelId, true);
    };

    const onStopLoading = () => {
      setIsLoading(false);
      setBrowserPageLoading(panelId, false);
      updateNavState();
    };

    const onDidNavigate = (event: DidNavigateEvent | DidNavigateInPageEvent) => {
      // Before the first dom-ready this is the placeholder `src="about:blank"`, not the panel's
      // page: it would make a panel opened on a URL count as blank until that page commits.
      if (!readyRef.current) return;
      if (event.type === "did-navigate") {
        // A new page drops the matches and the find session.
        setFindMatches(null);
        findSessionStaleRef.current = true;
      }
      // The page's own URL, not `event.url`: that is a subframe's for in-page navigations in
      // frames, and drops the `view-source:` prefix of a source view.
      const url = webview.getURL();
      setCurrentUrl(url);
      setInputUrl(url);
      setPageUrl(url);
      setBrowserPageUrl(panelId, url);
      if (event.type === "did-navigate") {
        // A new document reports its favicon once it has parsed its head. Until then a page of the
        // same site keeps the one before, which is most often its favicon too.
        const { faviconUrl } = pageRef.current;
        const keepFavicon = faviconUrl !== undefined && isSameOrigin(pageRef.current.url, url);
        faviconRequestRef.current++;
        pageRef.current = { url, title: "", ...(keepFavicon && { faviconUrl }) };
        panelApiRef.current?.updateParameters({ url, faviconUrl: pageRef.current.faviconUrl });
      } else {
        // The same document, which keeps its title and favicon (Chromium reports them per document).
        pageRef.current = { ...pageRef.current, url };
        panelApiRef.current?.updateParameters({ url });
      }
      updateNavState();
    };

    const onTitleUpdate = (event: PageTitleUpdatedEvent) => {
      pageRef.current = { ...pageRef.current, title: event.title };
      panelApiRef.current?.setTitle(event.title);
    };

    const setFavicon = (faviconUrl: string | undefined) => {
      pageRef.current = { ...pageRef.current, faviconUrl };
      panelApiRef.current?.updateParameters({ faviconUrl });
    };

    // Chromium lists the page's favicons, its preferred first. Pages change them as they please (an
    // unread count, a build status); each change fires the event again.
    const onFaviconUpdate = (event: PageFaviconUpdatedEvent) => {
      const candidates = faviconCandidates(event.favicons);
      const [first] = candidates;
      if (!first) return;
      const request = ++faviconRequestRef.current;
      const isCurrent = () => request === faviconRequestRef.current;
      // The preferred one shows at once, and gives way to the next one that loads if it doesn't.
      // Only the page that made a `blob:` URL can read it, so main reads it there.
      if (!first.startsWith("blob:")) setFavicon(first);
      const readBlob = (url: string) =>
        window.electronAPI?.loadFavicon(url, undefined, webview.getWebContentsId()) ??
        Promise.resolve(null);
      void pickFavicon(candidates, pageRef.current.url, readBlob, isCurrent).then((picked) => {
        if (isCurrent() && picked !== pageRef.current.faviconUrl) setFavicon(picked);
      });
    };

    const onFailLoad = (event: DidFailLoadEvent) => {
      // errorCode -3 is ERR_ABORTED (user stopped navigation) — not a real error. A subframe that
      // fails (a dead or framing-blocked embed) leaves the page itself loaded.
      if (event.errorCode === -3 || !event.isMainFrame) return;
      pageRef.current = { url: "", title: "" };
      setPageUrl("");
      setLoadError(
        `Failed to load ${event.validatedURL}: ${event.errorDescription} (${event.errorCode})`,
      );
      setIsLoading(false);
    };

    const onFoundInPage = ({ result }: FoundInPageEvent) => {
      // Ignore results of a superseded search (the query changed since).
      if (result.requestId !== findRequestRef.current) return;
      setFindMatches({ active: result.activeMatchOrdinal, total: result.matches });
    };

    const onContextMenu = ({ params }: ContextMenuEvent) => {
      setContextMenu({
        open: true,
        webview,
        params,
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward(),
      });
    };

    const onDevToolsOpened = () => setDevToolsOpen(true);
    const onDevToolsClosed = () => setDevToolsOpen(false);

    webview.addEventListener("did-start-loading", onStartLoading);
    webview.addEventListener("did-stop-loading", onStopLoading);
    webview.addEventListener("did-start-navigation", onStartNavigation);
    webview.addEventListener("did-navigate", onDidNavigate);
    webview.addEventListener("did-navigate-in-page", onDidNavigate);
    webview.addEventListener("page-title-updated", onTitleUpdate);
    webview.addEventListener("page-favicon-updated", onFaviconUpdate);
    webview.addEventListener("did-fail-load", onFailLoad);
    webview.addEventListener("found-in-page", onFoundInPage);
    webview.addEventListener("context-menu", onContextMenu);
    webview.addEventListener("devtools-opened", onDevToolsOpened);
    webview.addEventListener("devtools-closed", onDevToolsClosed);

    return () => {
      readyRef.current = false;
      webview.removeEventListener("dom-ready", onDomReady);
      webview.removeEventListener("did-start-loading", onStartLoading);
      webview.removeEventListener("did-stop-loading", onStopLoading);
      webview.removeEventListener("did-start-navigation", onStartNavigation);
      // An unloaded page loads nothing.
      setBrowserPageLoading(panelId, false);
      webview.removeEventListener("did-navigate", onDidNavigate);
      webview.removeEventListener("did-navigate-in-page", onDidNavigate);
      webview.removeEventListener("page-title-updated", onTitleUpdate);
      webview.removeEventListener("page-favicon-updated", onFaviconUpdate);
      webview.removeEventListener("did-fail-load", onFailLoad);
      webview.removeEventListener("found-in-page", onFoundInPage);
      webview.removeEventListener("context-menu", onContextMenu);
      webview.removeEventListener("devtools-opened", onDevToolsOpened);
      webview.removeEventListener("devtools-closed", onDevToolsClosed);
    };
  }, [panelId]);

  const navigate = useCallback(
    (url: string) => {
      const webview = webviewRef.current;
      if (!webview || !readyRef.current) return;

      const normalized = addressBarUrl(url);

      setInputUrl(normalized);
      setCurrentUrl(normalized);
      setLoadError(null);
      dismissDialogs();
      loadUrl(webview, normalized);
    },
    [dismissDialogs],
  );

  const goBack = useCallback(() => {
    if (!readyRef.current) return;
    dismissDialogs();
    webviewRef.current?.goBack();
  }, [dismissDialogs]);

  const goForward = useCallback(() => {
    if (!readyRef.current) return;
    dismissDialogs();
    webviewRef.current?.goForward();
  }, [dismissDialogs]);

  const reload = useCallback(() => {
    if (!readyRef.current) return;
    dismissDialogs();
    webviewRef.current?.reload();
  }, [dismissDialogs]);

  const hardRefresh = useCallback(() => {
    if (!readyRef.current) return;
    dismissDialogs();
    webviewRef.current?.reloadIgnoringCache();
  }, [dismissDialogs]);

  // Pages of the web only: not the blank page, or Chromium's error and internal pages.
  const canBookmark = isHttpUrl(pageUrl);
  const toggleBookmark = useCallback(() => {
    const page = pageRef.current;
    if (!isHttpUrl(page.url)) return;
    useBrowserBookmarksStore.getState().toggleBookmark({ ...page, title: page.title || page.url });
  }, []);

  const browserPanelTarget = useMemo(
    () => ({ hardRefresh, toggleBookmark }),
    [hardRefresh, toggleBookmark],
  );
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return registerBrowserPanelTarget(root, browserPanelTarget);
  }, [browserPanelTarget]);

  const stopLoading = useCallback(() => {
    if (readyRef.current) webviewRef.current?.stop();
  }, []);

  const toggleDevTools = useCallback(() => {
    const wv = webviewRef.current;
    if (!wv || !readyRef.current) return;
    if (wv.isDevToolsOpened()) {
      wv.closeDevTools();
    } else {
      wv.openDevTools();
    }
  }, []);

  const openBookmark = useCallback<OpenBookmark>(
    (url, inNewTab) => {
      if (inNewTab) {
        openBrowserTab(url, { sourcePanelId: panelId, activate: inNewTab.activate });
        return;
      }
      navigate(url);
      webviewRef.current?.focus();
    },
    [navigate, panelId],
  );

  // A closed dialog returns focus to the page, as browsers do; the next queued one then takes it.
  const returnFocusToPage = useCallback(() => webviewRef.current?.focus(), []);

  const handleUrlKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        navigate(inputUrl);
        e.currentTarget.blur();
      } else if (e.key === "Escape") {
        setInputUrl(currentUrl);
        e.currentTarget.blur();
      }
    },
    [inputUrl, currentUrl, navigate],
  );

  const handleUrlFocus = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.select();
  }, []);

  if (!isElectron) {
    return (
      <div className="bg-editor-surface text-muted-foreground flex h-full flex-col items-center justify-center gap-3">
        <GlobeIcon className="size-10" />
        <p className="text-sm">Browser tabs require the desktop app</p>
        {initialUrl && (
          <a
            href={initialUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-link text-sm underline"
          >
            Open in browser
          </a>
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="bg-editor-surface flex h-full flex-col overflow-hidden">
      {/* Navigation toolbar */}
      <div className="border-border flex h-8 shrink-0 items-center gap-1 border-b px-1.5">
        <NavButton onClick={goBack} disabled={!canGoBack} title="Back">
          <ArrowLeftIcon className="size-3.5" />
        </NavButton>
        <NavButton onClick={goForward} disabled={!canGoForward} title="Forward">
          <ArrowRightIcon className="size-3.5" />
        </NavButton>
        <NavButton onClick={isLoading ? stopLoading : reload} title={isLoading ? "Stop" : "Reload"}>
          {isLoading ? <XIcon className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
        </NavButton>

        {/* URL bar */}
        <div className="bg-background border-border flex flex-1 items-center gap-1.5 rounded border px-2 py-0.5">
          {isLoading ? (
            <LoaderIcon className="text-muted-foreground size-3 shrink-0 animate-spin" />
          ) : (
            <GlobeIcon className="text-muted-foreground size-3 shrink-0" />
          )}
          <input
            ref={urlInputRef}
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleUrlKeyDown}
            onFocus={handleUrlFocus}
            className="text-foreground min-w-0 flex-1 bg-transparent text-xs outline-none"
            spellCheck={false}
          />
          <BookmarkToggle
            bookmarked={isBookmarked}
            disabled={!canBookmark}
            onToggle={toggleBookmark}
          />
        </div>

        <BookmarksMenu onOpen={openBookmark} />

        <NavButton
          onClick={toggleDevTools}
          title={devToolsOpen ? "Close DevTools" : "Open DevTools"}
        >
          <BugIcon className={cn("size-3.5", devToolsOpen && "text-foreground")} />
        </NavButton>
      </div>

      {notificationRequest && (
        <NotificationPermissionBar
          key={notificationRequest.id}
          request={notificationRequest}
          onAnswer={answerNotificationRequest}
        />
      )}

      {mediaRequest && (
        <MediaPermissionBar
          key={mediaRequest.id}
          request={mediaRequest}
          onAnswer={answerMediaRequest}
        />
      )}

      {mediaSystemBlocked && (
        <MediaSystemBlockedBar notice={mediaSystemBlocked} onDismiss={dismissMediaSystemBlocked} />
      )}

      {/* Error banner */}
      {loadError && (
        <div className="border-border bg-destructive/10 text-destructive flex items-center gap-2 border-b px-3 py-1.5 text-xs">
          <AlertTriangleIcon className="size-3.5 shrink-0" />
          <span className="truncate">{loadError}</span>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {/* Webview — Electron custom element, enabled via webviewTag in main.ts */}
        <webview
          ref={webviewRef as React.Ref<HTMLElement>}
          src="about:blank"
          partition={BROWSER_PARTITION}
          {...popupAttributes}
          className="flex-1"
          style={{ display: "flex" }}
        />
        {isBlankPage(currentUrl) && <BookmarksStartPage onOpen={openBookmark} />}
        {findBarProps && <FindBar label="Find in page" {...findBarProps} />}
        {dialog && (
          <JavaScriptDialog
            key={dialog.id}
            request={dialog}
            focusScopeRef={rootRef}
            focusRef={dialogFocusRef}
            onAnswer={answerDialog}
            onReturnFocus={returnFocusToPage}
          />
        )}
        <PasskeyQrOverlay webContentsId={webContentsId} />
      </div>
      {contextMenu && (
        <BrowserContextMenu
          menu={contextMenu}
          panelId={panelId}
          onOpenChange={(open) => setContextMenu((menu) => menu && { ...menu, open })}
        />
      )}
    </div>
  );
}

/** Load a URL, leaving failures to the `did-fail-load` event, which reports them in the panel. */
function loadUrl(webview: WebviewTag, url: string): void {
  webview.loadURL(url).catch(() => {});
}

function NavButton({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="text-muted-foreground hover:text-foreground hover:bg-muted disabled:text-muted-foreground/40 flex size-6 cursor-pointer items-center justify-center rounded transition-colors disabled:cursor-default"
    >
      {children}
    </button>
  );
}
