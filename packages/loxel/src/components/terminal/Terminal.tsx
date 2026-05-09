/**
 * Core terminal component using xterm.js.
 * Accepts a terminalId and optional close/create callbacks.
 */
import type { DockviewPanelApi } from "dockview-react";

import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";

import type { OscPayload } from "@/lib/osc-notification-parser";

import * as api from "@/api/client";
import { wsClient } from "@/api/client";
import { usePanelWorktreePath } from "@/components/dockview/panel-context";
import { usePanelActivationFocus } from "@/hooks/usePanelActivationFocus";
import { frontendLog } from "@/lib/frontend-logger";
import { parseOsc777, parseOsc9, parseOsc99 } from "@/lib/osc-notification-parser";
import { WINDOW_ID } from "@/lib/window-id";
import { useFileSearchStore } from "@/store/file-search";
import { usePanelNotificationStore } from "@/store/panel-notifications";
import { useSettingsStore } from "@/store/settings-store";
import { useUIStore } from "@/store/ui";

import { type FileIndex, buildFileIndex, createFilePathLinkProvider } from "./file-link-provider";
import { SEARCH_DECORATIONS } from "./search-decorations";
import { TerminalSearchBar } from "./TerminalSearchBar";

import "@xterm/xterm/css/xterm.css";

/** Read a CSS variable from :root. */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Build xterm.js theme from CSS variables defined in index.css. */
function getTerminalTheme() {
  const bg = cssVar("--editor-surface");
  return {
    background: bg,
    foreground: cssVar("--term-foreground"),
    cursor: cssVar("--term-cursor"),
    cursorAccent: bg,
    selectionBackground: cssVar("--term-selection"),
    black: cssVar("--term-black"),
    red: cssVar("--term-red"),
    green: cssVar("--term-green"),
    yellow: cssVar("--term-yellow"),
    blue: cssVar("--term-blue"),
    magenta: cssVar("--term-magenta"),
    cyan: cssVar("--term-cyan"),
    white: cssVar("--term-white"),
    brightBlack: cssVar("--term-bright-black"),
    brightRed: cssVar("--term-bright-red"),
    brightGreen: cssVar("--term-bright-green"),
    brightYellow: cssVar("--term-bright-yellow"),
    brightBlue: cssVar("--term-bright-blue"),
    brightMagenta: cssVar("--term-bright-magenta"),
    brightCyan: cssVar("--term-bright-cyan"),
    brightWhite: cssVar("--term-bright-white"),
  };
}

const RESIZE_DEBOUNCE_MS = 100;

/** Open a URL: Cmd+click opens in browser panel, plain click opens in system browser. */
function openUrl(event: MouseEvent, url: string) {
  try {
    const { protocol } = new URL(url);
    if (protocol !== "https:" && protocol !== "http:") return;
  } catch {
    return;
  }
  if (event.metaKey) {
    window.dispatchEvent(new CustomEvent("loxel-create-browser", { detail: { url } }));
  } else {
    window.open(url);
  }
}

const termLog = frontendLog.child("terminal");

/** Send terminal_create with current dimensions and the panel's working directory. */
function sendCreate(terminalId: string, terminal: XTerm, cwd: string) {
  wsClient.send({
    type: "terminal_create",
    id: terminalId,
    cols: terminal.cols,
    rows: terminal.rows,
    cwd,
    scrollbackLines: useSettingsStore.getState().terminal.scrollbackLines,
    windowId: WINDOW_ID,
  });
  termLog.info("Terminal created", { terminalId, cwd, cols: terminal.cols, rows: terminal.rows });
}

interface TerminalProps {
  terminalId: string;
  onClose?: () => void;
  onCreateNew?: () => void;
  panelApi: DockviewPanelApi;
}

export function Terminal({ terminalId, onClose, onCreateNew, panelApi }: TerminalProps) {
  const panelWorktreePath = usePanelWorktreePath();
  const darkMode = useUIStore((s) => s.darkMode);
  const scrollbackLines = useSettingsStore((s) => s.terminal.scrollbackLines);
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);

  usePanelActivationFocus(
    panelApi,
    useCallback(() => xtermRef.current?.focus(), []),
  );
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const exitedRef = useRef(false);
  const createdRef = useRef(false);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [searchVisible, setSearchVisible] = useState(false);
  const searchTermRef = useRef("");

  const cwdRef = useRef(panelWorktreePath);
  cwdRef.current = panelWorktreePath;
  const fileIndexRef = useRef<FileIndex | null>(null);
  const onCloseRef = useRef(onClose);
  const onCreateNewRef = useRef(onCreateNew);
  onCloseRef.current = onClose;
  onCreateNewRef.current = onCreateNew;

  // Initialize xterm and wire up WebSocket communication
  useEffect(() => {
    if (!containerRef.current || xtermRef.current) return;

    const terminal = new XTerm({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono NL', monospace",
      fontSize: 13,
      fontWeight: "400",
      fontWeightBold: "500",
      letterSpacing: 0,
      lineHeight: 1.1,
      linkHandler: { activate: (event, text) => openUrl(event, text) },
      macOptionIsMeta: true,
      scrollback: useSettingsStore.getState().terminal.scrollbackLines,
      scrollOnEraseInDisplay: true,
      theme: getTerminalTheme(),
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const webLinksAddon = new WebLinksAddon((event, uri) => openUrl(event, uri));

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(containerRef.current);

    // File path link detection: prefixed paths (/, ./, ../, ~/) and bare filenames
    // matched against the project file index.
    const fileLinks = terminal.registerLinkProvider(
      createFilePathLinkProvider(
        terminal,
        () => cwdRef.current,
        () => fileIndexRef.current,
      ),
    );

    // Register OSC notification handlers — always register all three, check
    // settings at fire time so toggling in Settings takes effect immediately.
    // Sends parsed payloads to the server for multi-instance sync.
    const sendNotification = (payload: OscPayload) => {
      const store = usePanelNotificationStore.getState();
      const worktreePath = store.panelWorktreeMap[terminalId];
      if (!worktreePath) return;
      wsClient.send({
        type: "notification_add",
        source: { kind: "terminal", panelId: terminalId, worktreePath },
        title: payload.title,
        body: payload.body,
        urgency: payload.urgency,
      });
    };
    const notifDisposables = [
      terminal.parser.registerOscHandler(9, (data) => {
        if (useSettingsStore.getState().terminal.notificationSequences.osc9) {
          sendNotification(parseOsc9(data));
        }
        return false;
      }),
      terminal.parser.registerOscHandler(777, (data) => {
        if (!useSettingsStore.getState().terminal.notificationSequences.osc777) return false;
        const parsed = parseOsc777(data);
        if (parsed) sendNotification(parsed);
        return false;
      }),
      terminal.parser.registerOscHandler(99, (data) => {
        if (useSettingsStore.getState().terminal.notificationSequences.osc99) {
          sendNotification(parseOsc99(data));
        }
        return false;
      }),
    ];

    // Keyboard shortcuts
    terminal.attachCustomKeyEventHandler((event) => {
      // Block modified Enter on ALL event types (keydown, keypress, keyup) to prevent
      // the keypress from generating a second newline via xterm's normal input path.
      // Only send the actual escape sequence on keydown.
      if (
        event.key === "Enter" &&
        (event.shiftKey || event.ctrlKey) &&
        !event.metaKey &&
        !event.altKey
      ) {
        if (event.type === "keydown") {
          if (event.shiftKey) {
            wsClient.sendTerminalInput(terminalId, "\x1b\r");
          } else {
            wsClient.sendTerminalInput(terminalId, "\x1b[13;5u");
          }
        }
        return false;
      }

      if (event.type !== "keydown") return true;

      // --- Cmd+key: app-level shortcuts (xterm passes these to browser) ---
      // Cmd+N and Cmd+W are handled by the global keybinding system (useKeybindings).
      // Returning true lets xterm pass them through to the DOM where the global handler picks them up.

      if (event.metaKey && event.key === "k") {
        terminal.clear();
        return false;
      }
      if (event.metaKey && event.key === "l") {
        wsClient.sendTerminalInput(terminalId, "\x0c");
        return false;
      }
      if (event.metaKey && event.key === "Backspace") {
        wsClient.sendTerminalInput(terminalId, "\x15");
        return false;
      }
      if (event.metaKey && event.key === "Delete") {
        wsClient.sendTerminalInput(terminalId, "\x0b");
        return false;
      }
      if (event.metaKey && event.key === "f") {
        setSearchVisible(true);
        return false;
      }
      if (event.metaKey && !event.shiftKey && event.key === "g") {
        if (searchTermRef.current) {
          searchAddon.findNext(searchTermRef.current, { decorations: SEARCH_DECORATIONS });
        }
        return false;
      }
      if (event.metaKey && event.shiftKey && event.key === "G") {
        if (searchTermRef.current) {
          searchAddon.findPrevious(searchTermRef.current, { decorations: SEARCH_DECORATIONS });
        }
        return false;
      }
      if (event.metaKey && event.key === "ArrowUp") {
        terminal.scrollToTop();
        return false;
      }
      if (event.metaKey && event.key === "ArrowDown") {
        terminal.scrollToBottom();
        return false;
      }
      if (event.metaKey && event.key === "ArrowLeft") {
        wsClient.sendTerminalInput(terminalId, "\x01");
        return false;
      }
      if (event.metaKey && event.key === "ArrowRight") {
        wsClient.sendTerminalInput(terminalId, "\x05");
        return false;
      }

      // --- Alt+arrow: word navigation (broader compat than CSI modified arrows) ---

      if (event.altKey && event.key === "ArrowLeft") {
        wsClient.sendTerminalInput(terminalId, "\x1bb");
        return false;
      }
      if (event.altKey && event.key === "ArrowRight") {
        wsClient.sendTerminalInput(terminalId, "\x1bf");
        return false;
      }

      return true;
    });

    // Fit after opening and send create to server
    const rafId = requestAnimationFrame(() => {
      fitAddon.fit();
      if (cwdRef.current) sendCreate(terminalId, terminal, cwdRef.current);
      createdRef.current = true;
      exitedRef.current = false;
    });

    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    exitedRef.current = false;
    createdRef.current = false;

    // Send user input as binary frames
    const inputDisposable = terminal.onData((data) => {
      if (!exitedRef.current) {
        wsClient.sendTerminalInput(terminalId, data);
      }
    });

    // Receive raw PTY output as binary frames
    const unsubOutput = wsClient.onTerminalOutput(terminalId, (data) => {
      terminal.write(data);
    });

    // Listen for terminal exit
    const unsubscribe = wsClient.subscribe((msg) => {
      if (msg.type === "terminal_exit" && msg.id === terminalId) {
        exitedRef.current = true;
        terminal.write(`\r\n\x1b[90m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`);
        termLog.info("Terminal exited", { terminalId, exitCode: msg.exitCode });
      }
    });

    // On WebSocket reconnect, re-create the PTY
    const unsubReconnect = wsClient.onReconnect(() => {
      if (exitedRef.current) return;
      terminal.reset();
      if (cwdRef.current) sendCreate(terminalId, terminal, cwdRef.current);
      termLog.info("Terminal reconnected", { terminalId });
    });

    return () => {
      cancelAnimationFrame(rafId);
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      inputDisposable.dispose();
      fileLinks.dispose();
      for (const d of notifDisposables) d.dispose();
      unsubOutput();
      unsubscribe();
      unsubReconnect();
      terminal.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [terminalId]);

  // Populate file index for bare filename matching in terminal links.
  // Uses the cached index if available, otherwise fetches in background.
  useEffect(() => {
    if (!panelWorktreePath) return;

    const cached = useFileSearchStore.getState().indexByWorktree.get(panelWorktreePath);
    if (cached) {
      fileIndexRef.current = buildFileIndex(cached.files);
      return;
    }

    let cancelled = false;
    api.getFileIndex(panelWorktreePath).then((res) => {
      if (cancelled) return;
      useFileSearchStore.getState().setFiles(panelWorktreePath, res.files, res.truncated);
      fileIndexRef.current = buildFileIndex(res.files);
    });
    return () => {
      cancelled = true;
    };
  }, [panelWorktreePath]);

  // Handle container resize with debounce
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver(() => {
      if (!fitAddonRef.current || !xtermRef.current || !createdRef.current) return;

      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        if (!fitAddonRef.current || !xtermRef.current) return;
        fitAddonRef.current.fit();
        wsClient.send({
          type: "terminal_resize",
          id: terminalId,
          cols: xtermRef.current.cols,
          rows: xtermRef.current.rows,
        });
        xtermRef.current.scrollToBottom();
      }, RESIZE_DEBOUNCE_MS);
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [terminalId]);

  // Update terminal theme when dark mode changes
  useEffect(() => {
    if (!xtermRef.current) return;
    const id = requestAnimationFrame(() => {
      if (xtermRef.current) {
        xtermRef.current.options.theme = getTerminalTheme();
      }
    });
    return () => cancelAnimationFrame(id);
  }, [darkMode]);

  // Update scrollback buffer when setting changes
  useEffect(() => {
    if (!xtermRef.current) return;
    const id = requestAnimationFrame(() => {
      if (xtermRef.current) {
        xtermRef.current.options.scrollback = scrollbackLines;
      }
    });
    return () => cancelAnimationFrame(id);
  }, [scrollbackLines]);

  // Focus terminal on click
  const handleClick = useCallback(() => {
    xtermRef.current?.focus();
  }, []);

  const handleSearchClose = useCallback(() => {
    setSearchVisible(false);
    searchTermRef.current = "";
    xtermRef.current?.focus();
  }, []);

  const handleSearchTermChange = useCallback((term: string) => {
    searchTermRef.current = term;
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div
        ref={containerRef}
        className="h-full w-full overflow-hidden p-2"
        style={{ backgroundColor: "var(--editor-surface)" }}
        onMouseDown={handleClick}
      />
      {searchVisible && searchAddonRef.current && (
        <TerminalSearchBar
          searchAddon={searchAddonRef.current}
          onClose={handleSearchClose}
          onSearchTermChange={handleSearchTermChange}
        />
      )}
    </div>
  );
}
