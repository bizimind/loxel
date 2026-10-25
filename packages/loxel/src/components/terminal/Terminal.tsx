/**
 * Core terminal component using xterm.js.
 * Accepts a terminalId and optional close/create callbacks.
 */

import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import type { DockviewPanelApi } from "dockview-react";
import { useCallback, useEffect, useRef } from "react";

import * as api from "@/api/client";
import { wsClient } from "@/api/client";
import type { TerminalState } from "@/api/ws-protocol";
import { usePanelWorktreePath } from "@/components/dockview/panel-context";
import { FindBar } from "@/components/ui/find-bar";
import { isActivatedPanel, usePanelActivationFocus } from "@/hooks/usePanelActivationFocus";
import { usePanelFind } from "@/hooks/usePanelFind";
import { frontendLog } from "@/lib/frontend-logger";
import { WINDOW_ID } from "@/lib/window-id";
import { useFileSearchStore } from "@/store/file-search";
import { useSettingsStore } from "@/store/settings-store";
import { useUIStore } from "@/store/ui";

import {
  type FileIndex,
  type TerminalPaths,
  buildFileIndex,
  createFilePathLinkProvider,
} from "./file-link-provider";
import { SEARCH_DECORATIONS } from "./search-decorations";
import { createWebglRenderer } from "./webgl-renderer";

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

const TERMINAL_FONT = {
  family: "JetBrains Mono NL",
  size: 13,
  weight: "400",
  weightBold: "500",
} as const;

const TERMINAL_FONT_TIMEOUT_MS = 2000;

/**
 * Resolve once the terminal's font faces are loaded, failed, or timed out. xterm measures the cell
 * grid and the WebGL renderer rasterizes glyphs on open, and neither re-checks when a web font
 * swaps in, so opening earlier would bake the fallback font into the grid and the glyph atlas.
 */
function loadTerminalFont(): Promise<unknown> {
  // Load the family's FontFace objects directly: Chromium's document.fonts.load() matches no faces
  // for this family (its local() fallback face for U+23FA in index.css breaks matching) and
  // resolves without loading anything.
  const faces = [...document.fonts].filter(
    (face) => face.family.replaceAll('"', "") === TERMINAL_FONT.family,
  );
  const loaded = Promise.allSettled(faces.map((face) => face.load()));
  const timeout = new Promise((resolve) => {
    setTimeout(resolve, TERMINAL_FONT_TIMEOUT_MS);
  });
  return Promise.race([loaded, timeout]);
}

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

/** Fit the terminal to its container and sync changed dimensions to the PTY. */
function fitAndSendResize(terminalId: string, terminal: XTerm, fitAddon: FitAddon) {
  const { cols, rows } = terminal;
  fitAddon.fit();
  if (terminal.cols === cols && terminal.rows === rows) return;
  wsClient.send({
    type: "terminal_resize",
    id: terminalId,
    cols: terminal.cols,
    rows: terminal.rows,
  });
}

/** Output bytes parsed between flow-control acks to the server. */
const ACK_BYTES = 64 * 1024;

/**
 * Send terminal_attach with current dimensions and the panel's spawn target. `sinceOffset` is the
 * stream offset this xterm is already current to (a reconnect with live content); omitted for a
 * fresh xterm, which gets a snapshot.
 */
function sendAttach(
  terminalId: string,
  terminal: XTerm,
  { cwd, worktreePath }: TerminalPaths,
  since?: { epoch: string; offset: number },
) {
  wsClient.send({
    type: "terminal_attach",
    id: terminalId,
    cols: terminal.cols,
    rows: terminal.rows,
    cwd,
    worktreePath,
    scrollbackLines: useSettingsStore.getState().terminal.scrollbackLines,
    activatePythonEnv: useSettingsStore.getState().terminal.activatePythonEnv,
    windowId: WINDOW_ID,
    ...(since === undefined ? {} : { sinceEpoch: since.epoch, sinceOffset: since.offset }),
  });
  termLog.info("Terminal attach requested", {
    terminalId,
    cwd,
    worktreePath,
    cols: terminal.cols,
    rows: terminal.rows,
    since,
  });
}

interface OutputFrame {
  offset: number;
  data: Uint8Array;
}

/**
 * Keeps an xterm in step with the server's output stream. Between an attach request and its
 * `terminal_state` reply, frames are queued; the reply says which offset the xterm is current to,
 * and queued frames before it are dropped. Live frames are acked in `ACK_BYTES` steps once parsed.
 */
class OutputStream {
  /** Offset the xterm is current to, or null before the first state. */
  nextOffset: number | null = null;
  /** Epoch of the session the offset belongs to. */
  epoch: string | null = null;
  /** Offset of the current sync's state message; acks quote it. */
  private syncOffset = 0;
  private awaitingState = false;
  private queued: OutputFrame[] = [];
  private unackedBytes = 0;

  constructor(
    private readonly terminalId: string,
    private readonly terminal: XTerm,
  ) {}

  /** Mark that an attach has been sent; frames queue until the state reply. */
  expectState(): void {
    this.awaitingState = true;
    this.queued = [];
  }

  receive(offset: number, data: Uint8Array): void {
    if (this.awaitingState) {
      this.queued.push({ offset, data });
      return;
    }
    this.writeLive(offset, data);
  }

  /** The sync point to resume from after a reconnect, if the xterm has one. */
  get since(): { epoch: string; offset: number } | undefined {
    if (this.epoch === null || this.nextOffset === null) return undefined;
    return { epoch: this.epoch, offset: this.nextOffset };
  }

  applyState(state: TerminalState): void {
    if (state.mode === "snapshot") {
      // RIS in-band instead of terminal.reset(): write() is async, so a synchronous reset would
      // clear the screen before output still queued in xterm's write buffer is parsed onto it.
      this.terminal.write(`\x1bc${state.snapshot ?? ""}`);
    }
    this.epoch = state.epoch;
    this.nextOffset = state.offset;
    this.syncOffset = state.offset;
    this.awaitingState = false;
    this.unackedBytes = 0;
    const queued = this.queued;
    this.queued = [];
    for (const frame of queued) {
      if (frame.offset >= state.offset) this.writeLive(frame.offset, frame.data);
    }
  }

  private writeLive(offset: number, data: Uint8Array): void {
    this.nextOffset = offset + data.byteLength;
    const syncOffset = this.syncOffset;
    this.terminal.write(data, () => {
      // Bytes written under an earlier sync are not counted against the current one.
      if (syncOffset !== this.syncOffset) return;
      this.unackedBytes += data.byteLength;
      if (this.unackedBytes < ACK_BYTES) return;
      wsClient.send({
        type: "terminal_ack",
        id: this.terminalId,
        syncOffset,
        bytes: this.unackedBytes,
      });
      this.unackedBytes = 0;
    });
  }
}

interface TerminalProps {
  terminalId: string;
  /** Directory the shell starts in when it is not the panel's worktree. */
  cwd?: string;
  onClose?: () => void;
  onCreateNew?: () => void;
  panelApi: DockviewPanelApi;
}

export function Terminal({ terminalId, cwd, onClose, onCreateNew, panelApi }: TerminalProps) {
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
  const attachedRef = useRef(false);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { barProps: findBarProps, setMatches: setFindMatches } = usePanelFind(rootRef, {
    find: (query, direction, newQuery) => {
      const searchAddon = searchAddonRef.current;
      if (!searchAddon) return;
      if (direction === "next") {
        searchAddon.findNext(query, { incremental: newQuery, decorations: SEARCH_DECORATIONS });
      } else {
        searchAddon.findPrevious(query, { decorations: SEARCH_DECORATIONS });
      }
    },
    clear: () => searchAddonRef.current?.clearDecorations(),
    close: () => {
      searchAddonRef.current?.clearDecorations();
      xtermRef.current?.focus();
    },
  });

  const spawnTarget: TerminalPaths | null = panelWorktreePath
    ? { cwd: cwd ?? panelWorktreePath, worktreePath: panelWorktreePath }
    : null;
  const spawnTargetRef = useRef(spawnTarget);
  spawnTargetRef.current = spawnTarget;
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
      fontFamily: `"${TERMINAL_FONT.family}", monospace`,
      fontSize: TERMINAL_FONT.size,
      fontWeight: TERMINAL_FONT.weight,
      fontWeightBold: TERMINAL_FONT.weightBold,
      letterSpacing: 0,
      lineHeight: 1.1,
      linkHandler: { activate: (event, text) => openUrl(event, text) },
      macOptionIsMeta: true,
      // The search addon highlights matches with decorations, a proposed API.
      allowProposedApi: true,
      scrollback: useSettingsStore.getState().terminal.scrollbackLines,
      scrollOnEraseInDisplay: true,
      theme: getTerminalTheme(),
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const webLinksAddon = new WebLinksAddon((event, uri) => openUrl(event, uri));

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    const searchResults = searchAddon.onDidChangeResults(({ resultIndex, resultCount }) =>
      setFindMatches({ active: resultIndex + 1, total: resultCount }),
    );
    terminal.loadAddon(webLinksAddon);

    // File path link detection: prefixed paths (/, ./, ../, ~/) and bare filenames
    // matched against the project file index.
    const fileLinks = terminal.registerLinkProvider(
      createFilePathLinkProvider(
        terminal,
        () => spawnTargetRef.current,
        () => fileIndexRef.current,
      ),
    );

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
      // Cmd+N, Cmd+W and find (Cmd+F, Cmd+G) are handled by the global keybinding system
      // (useKeybindings).
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

    // WebGL only while visible: hidden tabs don't count against Chromium's context cap. Switching
    // renderers changes the cell size; the ResizeObserver refits when the panel is shown again.
    const webglRenderer = createWebglRenderer(terminal, terminalId, () => {
      if (attachedRef.current) fitAndSendResize(terminalId, terminal, fitAddon);
    });
    const visibility = panelApi.onDidVisibilityChange(({ isVisible }) => {
      if (isVisible) webglRenderer.attach();
      else webglRenderer.detach();
    });

    const output = new OutputStream(terminalId, terminal);

    // Open once the font is ready, then fit and attach to the server session
    const container = containerRef.current;
    let disposed = false;
    let rafId = 0;
    void loadTerminalFont().then(() => {
      if (disposed) return;
      terminal.open(container);
      if (panelApi.isVisible) webglRenderer.attach();
      // Activation focus before open() is a no-op (xterm has no textarea yet), so re-apply it.
      if (isActivatedPanel(panelApi)) terminal.focus();
      rafId = requestAnimationFrame(() => {
        fitAddon.fit();
        if (spawnTargetRef.current) {
          output.expectState();
          sendAttach(terminalId, terminal, spawnTargetRef.current);
          attachedRef.current = true;
        }
      });
    });

    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    exitedRef.current = false;
    attachedRef.current = false;

    // Send user input (and xterm's replies to terminal queries) as binary frames
    const inputDisposable = terminal.onData((data) => {
      if (!exitedRef.current) {
        wsClient.sendTerminalInput(terminalId, data);
      }
    });

    // Receive raw PTY output as offset-tagged binary frames
    const unsubOutput = wsClient.onTerminalOutput(terminalId, (offset, data) => {
      output.receive(offset, data);
    });

    // Terminal state (attach replies, resyncs) and exit
    const unsubscribe = wsClient.subscribe((msg) => {
      if (msg.type === "terminal_state" && msg.id === terminalId) {
        output.applyState(msg);
        termLog.info("Terminal state applied", {
          terminalId,
          mode: msg.mode,
          offset: msg.offset,
          snapshotBytes: msg.snapshot?.length,
        });
        // A fit may have changed the xterm between the attach request and this state.
        if (msg.cols !== terminal.cols || msg.rows !== terminal.rows) {
          wsClient.send({
            type: "terminal_resize",
            id: terminalId,
            cols: terminal.cols,
            rows: terminal.rows,
          });
        }
        return;
      }
      if (msg.type === "terminal_exit" && msg.id === terminalId) {
        exitedRef.current = true;
        terminal.write(`\r\n\x1b[90m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`);
        termLog.info("Terminal exited", { terminalId, exitCode: msg.exitCode });
      }
    });

    // On WebSocket reconnect, re-attach. The xterm keeps its content: the server resumes from the
    // offset it is current to, or answers with a snapshot (which resets it) if that is gone.
    const unsubReconnect = wsClient.onReconnect(() => {
      // Before the initial attach, the pending open sends terminal_attach itself.
      if (exitedRef.current || !attachedRef.current || !spawnTargetRef.current) return;
      output.expectState();
      sendAttach(terminalId, terminal, spawnTargetRef.current, output.since);
      termLog.info("Terminal reconnected", { terminalId });
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      if (attachedRef.current && !exitedRef.current) {
        wsClient.send({ type: "terminal_detach", id: terminalId });
      }
      inputDisposable.dispose();
      searchResults.dispose();
      fileLinks.dispose();
      unsubOutput();
      unsubscribe();
      unsubReconnect();
      visibility.dispose();
      webglRenderer.detach();
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

  // Handle container resize with debounce. Device pixel ratio changes (e.g. moving the window to
  // another display) also refit: the WebGL renderer's cell size is rounded in device pixels, so
  // the cols/rows that fit change even when the container's CSS size doesn't.
  useEffect(() => {
    if (!containerRef.current) return;

    const scheduleFit = () => {
      if (!fitAddonRef.current || !xtermRef.current || !attachedRef.current) return;

      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        if (!fitAddonRef.current || !xtermRef.current) return;
        fitAndSendResize(terminalId, xtermRef.current, fitAddonRef.current);
        xtermRef.current.scrollToBottom();
      }, RESIZE_DEBOUNCE_MS);
    };

    const observer = new ResizeObserver(scheduleFit);
    observer.observe(containerRef.current);

    // A resolution query only matches the current ratio, so re-arm it after each change.
    let dprQuery: MediaQueryList | null = null;
    const watchDevicePixelRatio = () => {
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprQuery.addEventListener("change", onDevicePixelRatioChange, { once: true });
    };
    const onDevicePixelRatioChange = () => {
      scheduleFit();
      watchDevicePixelRatio();
    };
    watchDevicePixelRatio();

    return () => {
      observer.disconnect();
      dprQuery?.removeEventListener("change", onDevicePixelRatioChange);
    };
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

  return (
    <div ref={rootRef} className="relative h-full w-full overflow-hidden">
      <div
        ref={containerRef}
        className="h-full w-full overflow-hidden p-2"
        style={{ backgroundColor: "var(--editor-surface)" }}
        onMouseDown={handleClick}
      />
      {findBarProps && <FindBar label="Find in terminal" {...findBarProps} />}
    </div>
  );
}
