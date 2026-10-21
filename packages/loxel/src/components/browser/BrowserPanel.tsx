import type { DockviewPanelApi } from "dockview-react";
import type {
  DidFailLoadEvent,
  DidNavigateEvent,
  DidNavigateInPageEvent,
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
import { useCallback, useEffect, useRef, useState } from "react";

import { FindBar } from "@/components/ui/find-bar";
import { BROWSER_PARTITION } from "@/electron/browser-partition";
import { usePanelActivationFocus } from "@/hooks/usePanelActivationFocus";
import { usePanelFind } from "@/hooks/usePanelFind";
import { openBrowserTab } from "@/lib/panel-creators";
import { cn } from "@/lib/utils";
import { reattachActiveContent } from "@/store/layout-actions";

import { BrowserContextMenu, type BrowserContextMenuState } from "./BrowserContextMenu";
import { webSearchUrl } from "./web-search";

const isElectron = navigator.userAgent.includes("Electron");

/**
 * Let pages ask for new tabs and windows (⌘-click, middle-click, `target="_blank"`,
 * `window.open`), which the main process turns into browser tabs. Only with a preload that
 * delivers those requests: an older main process opens them in the system browser instead.
 * Passed as a string: React drops `true` for attributes it does not know, though @types/react
 * types this one as a boolean.
 */
const popupAttributes: Record<string, string> = window.electronAPI?.onOpenInNewBrowserTab
  ? { allowpopups: "" }
  : {};

export interface BrowserPanelParams {
  url: string;
  faviconUrl?: string;
}

interface BrowserPanelProps {
  url: string;
  panelApi: DockviewPanelApi;
}

export function BrowserPanel({ url: initialUrl, panelApi }: BrowserPanelProps) {
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

  // Layouts saved before browser panels used the "always" renderer restore with the default
  // renderer; upgrade them so hidden tabs stay attached (see createBrowser).
  useEffect(() => {
    if (panelApi.renderer === "always") return;
    panelApi.setRenderer("always");
    reattachActiveContent(panelApi.group);
  }, [panelApi]);

  // Hand keyboard focus to the page when the panel is activated (e.g. directional focus).
  // Skip when focus is already inside the panel so clicking the URL bar keeps its focus.
  usePanelActivationFocus(
    panelApi,
    useCallback(() => {
      const webview = webviewRef.current;
      if (!webview || rootRef.current?.contains(document.activeElement)) return;
      webview.focus();
    }, []),
  );

  // Links the page opens in a new tab or window (⌘-click, middle-click, target="_blank", window.open).
  useEffect(
    () =>
      window.electronAPI?.onOpenInNewBrowserTab?.((webContentsId, url, background) => {
        const webview = webviewRef.current;
        if (!webview || !readyRef.current || webContentsId !== webview.getWebContentsId()) return;
        openBrowserTab(url, { sourcePanelId: panelApi.id, activate: !background });
      }),
    [panelApi],
  );

  // Attach webview event listeners
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const onDomReady = () => {
      if (!readyRef.current) {
        readyRef.current = true;
        if (initialUrl && initialUrl !== "about:blank") {
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

    const onStopLoading = () => {
      setIsLoading(false);
      updateNavState();
    };

    const onDidNavigate = (event: DidNavigateEvent | DidNavigateInPageEvent) => {
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
      panelApi.updateParameters({ url, faviconUrl: undefined });
      updateNavState();
    };

    const onTitleUpdate = (event: PageTitleUpdatedEvent) => {
      panelApi.setTitle(event.title);
    };

    const onFaviconUpdate = (event: PageFaviconUpdatedEvent) => {
      const favicon = event.favicons[0];
      if (favicon) {
        panelApi.updateParameters({ faviconUrl: favicon });
      }
    };

    const onFailLoad = (event: DidFailLoadEvent) => {
      // errorCode -3 is ERR_ABORTED (user stopped navigation) — not a real error
      if (event.errorCode === -3) return;
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
  }, [panelApi]);

  const navigate = useCallback((url: string) => {
    const webview = webviewRef.current;
    if (!webview || !readyRef.current) return;

    let normalized = url.trim();
    // A web URL, or the source view of one (View Page Source puts those in the address bar).
    if (!/^(view-source:)?https?:\/\//i.test(normalized)) {
      // If it looks like a domain (contains a dot), prepend https://
      // Otherwise treat it as a search query
      if (/^[^\s]+\.[^\s]+/.test(normalized)) {
        normalized = `https://${normalized}`;
      } else {
        normalized = webSearchUrl(normalized);
      }
    }

    setInputUrl(normalized);
    setCurrentUrl(normalized);
    setLoadError(null);
    loadUrl(webview, normalized);
  }, []);

  const goBack = useCallback(() => {
    if (readyRef.current) webviewRef.current?.goBack();
  }, []);

  const goForward = useCallback(() => {
    if (readyRef.current) webviewRef.current?.goForward();
  }, []);

  const reload = useCallback(() => {
    if (readyRef.current) webviewRef.current?.reload();
  }, []);

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
            className="text-primary text-sm underline"
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
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleUrlKeyDown}
            onFocus={handleUrlFocus}
            className="text-foreground min-w-0 flex-1 bg-transparent text-xs outline-none"
            spellCheck={false}
          />
        </div>

        <NavButton
          onClick={toggleDevTools}
          title={devToolsOpen ? "Close DevTools" : "Open DevTools"}
        >
          <BugIcon className={cn("size-3.5", devToolsOpen && "text-foreground")} />
        </NavButton>
      </div>

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
        {findBarProps && <FindBar label="Find in page" {...findBarProps} />}
      </div>
      {contextMenu && (
        <BrowserContextMenu
          menu={contextMenu}
          panelId={panelApi.id}
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
