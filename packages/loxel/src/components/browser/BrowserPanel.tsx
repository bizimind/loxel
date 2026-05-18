import type { DockviewPanelApi } from "dockview-react";
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

import { useActionHandler } from "@/hooks/useActionHandler";
import { cn } from "@/lib/utils";
import { inputToKeyCombo } from "@/store/keybindings/keybinding-schema";
import { useKeybindingStore } from "@/store/keybindings/keybinding-store";
import { useSettingsStore } from "@/store/settings-store";

const isElectron = navigator.userAgent.includes("Electron");

/** Electron webview event payloads (not in standard DOM typings). */
interface WebviewNavigateEvent extends Event {
  url: string;
}
interface WebviewTitleEvent extends Event {
  title: string;
}
interface WebviewFailLoadEvent extends Event {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
}
interface WebviewFaviconEvent extends Event {
  favicons: string[];
}
/**
 * Electron's before-input-event on the webview tag.
 * Event.type is read-only (always "before-input-event"), so the input direction
 * and key data live under a separate `input` property.
 */
interface WebviewBeforeInputEvent extends Event {
  input: {
    type: string;
    key: string;
    code: string;
    meta: boolean;
    control: boolean;
    alt: boolean;
    shift: boolean;
    isAutoRepeat: boolean;
    isComposing: boolean;
  };
}

/** Typed subset of Electron's webview API (not in React/DOM typings). */
interface ElectronWebView extends HTMLElement {
  loadURL(url: string): void;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  openDevTools(): void;
  closeDevTools(): void;
  isDevToolsOpened(): boolean;

  addEventListener(
    type: "before-input-event",
    listener: (event: WebviewBeforeInputEvent) => void,
  ): void;
  addEventListener(
    type: "did-navigate" | "did-navigate-in-page",
    listener: (event: WebviewNavigateEvent) => void,
  ): void;
  addEventListener(type: "page-title-updated", listener: (event: WebviewTitleEvent) => void): void;
  addEventListener(type: "did-fail-load", listener: (event: WebviewFailLoadEvent) => void): void;
  addEventListener(
    type: "page-favicon-updated",
    listener: (event: WebviewFaviconEvent) => void,
  ): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;

  removeEventListener(
    type: "before-input-event",
    listener: (event: WebviewBeforeInputEvent) => void,
  ): void;
  removeEventListener(
    type: "did-navigate" | "did-navigate-in-page",
    listener: (event: WebviewNavigateEvent) => void,
  ): void;
  removeEventListener(
    type: "page-title-updated",
    listener: (event: WebviewTitleEvent) => void,
  ): void;
  removeEventListener(type: "did-fail-load", listener: (event: WebviewFailLoadEvent) => void): void;
  removeEventListener(
    type: "page-favicon-updated",
    listener: (event: WebviewFaviconEvent) => void,
  ): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

export interface BrowserPanelParams {
  url: string;
  faviconUrl?: string;
}

interface BrowserPanelProps {
  url: string;
  panelApi: DockviewPanelApi;
}

export function BrowserPanel({ url: initialUrl, panelApi }: BrowserPanelProps) {
  const dispatch = useActionHandler();
  const webviewRef = useRef<ElectronWebView | null>(null);
  const readyRef = useRef(false);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [inputUrl, setInputUrl] = useState(initialUrl);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [devToolsOpen, setDevToolsOpen] = useState(false);

  // Attach webview event listeners
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const onDomReady = () => {
      if (!readyRef.current) {
        readyRef.current = true;
        if (initialUrl && initialUrl !== "about:blank") {
          webview.loadURL(initialUrl);
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

    const onDidNavigate = (event: WebviewNavigateEvent) => {
      setCurrentUrl(event.url);
      setInputUrl(event.url);
      panelApi.updateParameters({ url: event.url, faviconUrl: undefined });
      updateNavState();
    };

    const onTitleUpdate = (event: WebviewTitleEvent) => {
      panelApi.setTitle(event.title);
    };

    const onFaviconUpdate = (event: WebviewFaviconEvent) => {
      const favicon = event.favicons[0];
      if (favicon) {
        panelApi.updateParameters({ faviconUrl: favicon });
      }
    };

    const onFailLoad = (event: WebviewFailLoadEvent) => {
      // errorCode -3 is ERR_ABORTED (user stopped navigation) — not a real error
      if (event.errorCode === -3) return;
      setLoadError(
        `Failed to load ${event.validatedURL}: ${event.errorDescription} (${event.errorCode})`,
      );
      setIsLoading(false);
    };

    const onDevToolsOpened = () => setDevToolsOpen(true);
    const onDevToolsClosed = () => setDevToolsOpen(false);

    // Intercept keyboard input before it reaches the webview guest page.
    // Without this, loxel keybindings (Cmd+W, Cmd+T, etc.) are swallowed by the webview.
    const onBeforeInput = (event: WebviewBeforeInputEvent) => {
      const { input } = event;
      if (input.type !== "keyDown") return;
      if (useSettingsStore.getState().isOpen) return;
      if (
        input.key === "Meta" ||
        input.key === "Control" ||
        input.key === "Alt" ||
        input.key === "Shift"
      )
        return;
      if (input.isComposing) return;

      const combo = inputToKeyCombo(input);
      const actionId = useKeybindingStore.getState().lookup.get(combo);
      if (actionId) {
        event.preventDefault();
        dispatch(actionId);
      }
    };

    webview.addEventListener("before-input-event", onBeforeInput);
    webview.addEventListener("did-start-loading", onStartLoading);
    webview.addEventListener("did-stop-loading", onStopLoading);
    webview.addEventListener("did-navigate", onDidNavigate);
    webview.addEventListener("did-navigate-in-page", onDidNavigate);
    webview.addEventListener("page-title-updated", onTitleUpdate);
    webview.addEventListener("page-favicon-updated", onFaviconUpdate);
    webview.addEventListener("did-fail-load", onFailLoad);
    webview.addEventListener("devtools-opened", onDevToolsOpened);
    webview.addEventListener("devtools-closed", onDevToolsClosed);

    return () => {
      readyRef.current = false;
      webview.removeEventListener("before-input-event", onBeforeInput);
      webview.removeEventListener("dom-ready", onDomReady);
      webview.removeEventListener("did-start-loading", onStartLoading);
      webview.removeEventListener("did-stop-loading", onStopLoading);
      webview.removeEventListener("did-navigate", onDidNavigate);
      webview.removeEventListener("did-navigate-in-page", onDidNavigate);
      webview.removeEventListener("page-title-updated", onTitleUpdate);
      webview.removeEventListener("page-favicon-updated", onFaviconUpdate);
      webview.removeEventListener("did-fail-load", onFailLoad);
      webview.removeEventListener("devtools-opened", onDevToolsOpened);
      webview.removeEventListener("devtools-closed", onDevToolsClosed);
    };
  }, [panelApi, dispatch]);

  const navigate = useCallback((url: string) => {
    const webview = webviewRef.current;
    if (!webview || !readyRef.current) return;

    let normalized = url.trim();
    if (!/^https?:\/\//i.test(normalized)) {
      // If it looks like a domain (contains a dot), prepend https://
      // Otherwise treat it as a search query
      if (/^[^\s]+\.[^\s]+/.test(normalized)) {
        normalized = `https://${normalized}`;
      } else {
        normalized = `https://www.google.com/search?q=${encodeURIComponent(normalized)}`;
      }
    }

    setInputUrl(normalized);
    setCurrentUrl(normalized);
    setLoadError(null);
    webview.loadURL(normalized);
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
    <div className="bg-editor-surface flex h-full flex-col overflow-hidden">
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

      {/* Webview — Electron custom element, enabled via webviewTag in main.ts */}
      <webview
        ref={webviewRef as React.Ref<HTMLElement>}
        src="about:blank"
        partition="persist:browser"
        className="flex-1"
        style={{ display: "flex" }}
      />
    </div>
  );
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
