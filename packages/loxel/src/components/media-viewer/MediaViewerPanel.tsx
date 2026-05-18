import type { DockviewPanelApi } from "dockview-react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Maximize2Icon,
  MinusIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  Repeat1Icon,
  ScanIcon,
  ToggleLeftIcon,
  ToggleRightIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { wsClient } from "@/api/client";
import type { WsMessage } from "@/api/ws-protocol";
import { usePanelWorktreePath } from "@/components/dockview/panel-context";
import { getMediaType } from "@/lib/media-extensions";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ZOOM_STEP = 1.2;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 50;
const DRAG_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MediaViewerPanelProps {
  filePath: string;
  panelApi: DockviewPanelApi;
}

/** Messages posted by the media-frame iframe to this parent. Sender: `packages/loxel/src/server/routes.ts` (`/api/media-frame`). */
type IframeMessage =
  | { type: "media-dimensions"; width: number; height: number }
  | {
      type: "media-video-state";
      playing: boolean;
      currentTime: number;
      duration: number;
      volume: number;
      muted: boolean;
      playbackRate: number;
      loop: boolean;
    }
  | {
      type: "media-wheel";
      deltaX: number;
      deltaY: number;
      ctrlKey: boolean;
      metaKey: boolean;
      clientX: number;
      clientY: number;
    };

function isIframeMessage(data: unknown): data is IframeMessage {
  if (typeof data !== "object" || data === null || !("type" in data)) return false;
  const t = (data as { type: unknown }).type;
  return t === "media-dimensions" || t === "media-video-state" || t === "media-wheel";
}

interface Dimensions {
  width: number;
  height: number;
}

interface VideoState {
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  loop: boolean;
}

const PLAYBACK_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4];
const FRAME_STEP = 1 / 30; // ~1 frame at 30fps

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MediaViewerPanel({ filePath, panelApi }: MediaViewerPanelProps) {
  const worktreePath = usePanelWorktreePath();
  const isVideo = getMediaType(filePath) === "video";

  // --- State ---
  const [version, setVersion] = useState(1);
  const [dimensions, setDimensions] = useState<Dimensions | null>(null);
  const [scale, setScale] = useState(1);
  const [autoFit, setAutoFit] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [videoState, setVideoState] = useState<VideoState | null>(null);

  // --- Refs ---
  const viewportRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const translateRef = useRef({ x: 0, y: 0 });
  const dragStartRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const isDraggingRef = useRef(false);
  const scaleRef = useRef(1);

  // Keep scaleRef in sync
  scaleRef.current = scale;

  // --- URL ---
  const iframeSrc = worktreePath
    ? `/api/media-frame?path=${encodeURIComponent(filePath)}&wt=${encodeURIComponent(worktreePath)}&v=${version}`
    : "";

  // --- Send command to iframe video ---
  const sendCommand = useCallback((command: string, value?: number) => {
    iframeRef.current?.contentWindow?.postMessage({ type: "media-command", command, value }, "*");
  }, []);

  // --- Title sync ---
  useEffect(() => {
    const filename = filePath.split("/").pop() ?? "Media";
    panelApi.updateParameters({ filePath });
    panelApi.setTitle(filename);
  }, [filePath, panelApi]);

  // --- Apply transform ---
  const applyTransform = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const { x, y } = translateRef.current;
    iframe.style.transform = `translate(${x}px, ${y}px) scale(${scaleRef.current})`;
  }, []);

  // --- Actual-size scale: what scale shows 1 content pixel = 1 screen pixel ---
  const calcActualSizeScale = useCallback(
    (dims?: Dimensions | null) => {
      const d = dims ?? dimensions;
      const viewport = viewportRef.current;
      if (!d || !viewport) return 1;
      const vw = viewport.clientWidth;
      const vh = viewport.clientHeight;
      if (vw === 0 || vh === 0) return 1;
      const containRatio = Math.min(vw / d.width, vh / d.height);
      return containRatio > 0 ? 1 / containRatio : 1;
    },
    [dimensions],
  );

  // --- Shared zoom helper ---
  const applyZoom = useCallback(
    (factor: number) => {
      const s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scaleRef.current * factor));
      setScale(s);
      scaleRef.current = s;
      setAutoFit(false);
      applyTransform();
    },
    [applyTransform],
  );

  // --- Fit to contain ---
  const fitToContain = useCallback(() => {
    setScale(1);
    scaleRef.current = 1;
    translateRef.current = { x: 0, y: 0 };
    applyTransform();
  }, [applyTransform]);

  // --- Set 100% (actual size) ---
  const setActualSize = useCallback(() => {
    const s = calcActualSizeScale();
    setScale(s);
    scaleRef.current = s;
    translateRef.current = { x: 0, y: 0 };
    applyTransform();
  }, [calcActualSizeScale, applyTransform]);

  // --- Listen for postMessage from iframe ---
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      if (!isIframeMessage(e.data)) return;
      const msg = e.data;

      switch (msg.type) {
        case "media-dimensions":
          setDimensions({ width: msg.width, height: msg.height });
          break;
        case "media-video-state":
          setVideoState({
            playing: msg.playing,
            currentTime: msg.currentTime,
            duration: msg.duration,
            volume: msg.volume,
            muted: msg.muted,
            playbackRate: msg.playbackRate,
            loop: msg.loop,
          });
          break;
        case "media-wheel": {
          const viewport = viewportRef.current;
          if (!viewport) break;

          const { deltaX, deltaY, ctrlKey, metaKey, clientX, clientY } = msg;
          if (ctrlKey || metaKey) {
            const rect = viewport.getBoundingClientRect();
            const iframeRect = iframeRef.current.getBoundingClientRect();
            const cursorX = iframeRect.left - rect.left + clientX;
            const cursorY = iframeRect.top - rect.top + clientY;

            const oldScale = scaleRef.current;
            const factor = Math.pow(2, -deltaY * 0.01);
            const newScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, oldScale * factor));

            const cx = viewport.clientWidth / 2;
            const cy = viewport.clientHeight / 2;
            const worldX = (cursorX - cx - translateRef.current.x) / oldScale;
            const worldY = (cursorY - cy - translateRef.current.y) / oldScale;
            translateRef.current = {
              x: cursorX - cx - worldX * newScale,
              y: cursorY - cy - worldY * newScale,
            };

            scaleRef.current = newScale;
            setScale(newScale);
            setAutoFit(false);
            applyTransform();
          } else {
            translateRef.current = {
              x: translateRef.current.x - deltaX,
              y: translateRef.current.y - deltaY,
            };
            setAutoFit(false);
            applyTransform();
          }
          break;
        }
        default: {
          const _exhaustive: never = msg;
          throw new Error(`Unknown iframe message type: ${(_exhaustive as { type: string }).type}`);
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [applyTransform]);

  // --- Live reload on disk change ---
  useEffect(() => {
    const unsub = wsClient.subscribe((msg: WsMessage) => {
      if (msg.type === "file_content_changed" && msg.data.path === filePath) {
        setVersion((v) => v + 1);
      }
    });
    return unsub;
  }, [filePath]);

  // --- ResizeObserver for auto-fit ---
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      if (!autoFit) return;
      setScale(1);
      scaleRef.current = 1;
      translateRef.current = { x: 0, y: 0 };
      applyTransform();
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [autoFit, applyTransform]);

  // --- Wheel/trackpad on viewport background (non-passive) ---
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();

      if (e.ctrlKey || e.metaKey) {
        const rect = viewport.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const cursorY = e.clientY - rect.top;

        const oldScale = scaleRef.current;
        const factor = Math.pow(2, -e.deltaY * 0.01);
        const newScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, oldScale * factor));

        const cx = viewport.clientWidth / 2;
        const cy = viewport.clientHeight / 2;
        const worldX = (cursorX - cx - translateRef.current.x) / oldScale;
        const worldY = (cursorY - cy - translateRef.current.y) / oldScale;
        translateRef.current = {
          x: cursorX - cx - worldX * newScale,
          y: cursorY - cy - worldY * newScale,
        };

        scaleRef.current = newScale;
        setScale(newScale);
        setAutoFit(false);
        applyTransform();
      } else {
        translateRef.current = {
          x: translateRef.current.x - e.deltaX,
          y: translateRef.current.y - e.deltaY,
        };
        setAutoFit(false);
        applyTransform();
      }
    };

    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [applyTransform]);

  // --- Mouse drag for pan ---
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        tx: translateRef.current.x,
        ty: translateRef.current.y,
      };

      const handleMouseMove = (me: MouseEvent) => {
        const start = dragStartRef.current;
        if (!start) return;
        const dx = me.clientX - start.x;
        const dy = me.clientY - start.y;

        if (!isDraggingRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;

        if (!isDraggingRef.current) {
          isDraggingRef.current = true;
          setIsDragging(true);
        }
        translateRef.current = { x: start.tx + dx, y: start.ty + dy };
        setAutoFit(false);
        applyTransform();
      };

      const handleMouseUp = () => {
        dragStartRef.current = null;
        isDraggingRef.current = false;
        setIsDragging(false);
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [applyTransform],
  );

  // --- Double-click: toggle contain / actual size ---
  const handleDoubleClick = useCallback(() => {
    if (Math.abs(scaleRef.current - 1) < 0.01) {
      setActualSize();
      setAutoFit(false);
    } else {
      fitToContain();
      setAutoFit(true);
    }
  }, [fitToContain, setActualSize]);

  // --- Keyboard ---
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        applyZoom(ZOOM_STEP);
      } else if (e.key === "-") {
        e.preventDefault();
        applyZoom(1 / ZOOM_STEP);
      } else if (e.key === "0") {
        e.preventDefault();
        fitToContain();
        setAutoFit(true);
      } else if (isVideo && e.key === " ") {
        e.preventDefault();
        sendCommand("toggle");
      } else if (isVideo && e.key === "ArrowLeft") {
        e.preventDefault();
        sendCommand("step", -FRAME_STEP);
      } else if (isVideo && e.key === "ArrowRight") {
        e.preventDefault();
        sendCommand("step", FRAME_STEP);
      }
    },
    [applyZoom, fitToContain, isVideo, sendCommand],
  );

  const actualScale = calcActualSizeScale();
  const zoomPercent = actualScale > 0 ? Math.round((scale / actualScale) * 100) : 100;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="border-border bg-background flex h-8 shrink-0 items-center gap-1 border-b px-2 text-xs">
        <span className="text-muted-foreground min-w-0 shrink-0">
          {dimensions ? `${dimensions.width} \u00d7 ${dimensions.height}` : "\u2014"}
        </span>

        <div className="mx-auto" />

        <ToolbarButton onClick={() => applyZoom(1 / ZOOM_STEP)} title="Zoom out (-)">
          <MinusIcon className="size-3.5" />
        </ToolbarButton>
        <span className="text-muted-foreground w-10 text-center tabular-nums">{zoomPercent}%</span>
        <ToolbarButton onClick={() => applyZoom(ZOOM_STEP)} title="Zoom in (+)">
          <PlusIcon className="size-3.5" />
        </ToolbarButton>

        <div className="bg-border mx-1 h-3.5 w-px" />

        <ToolbarButton
          onClick={() => {
            fitToContain();
            setAutoFit(true);
          }}
          title="Fit to panel (0)"
        >
          <ScanIcon className="size-3.5" />
          <span>Fit</span>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => {
            setActualSize();
            setAutoFit(false);
          }}
          title="Actual size"
        >
          <Maximize2Icon className="size-3.5" />
          <span>1:1</span>
        </ToolbarButton>

        <div className="bg-border mx-1 h-3.5 w-px" />

        <ToolbarButton
          onClick={() => {
            const next = !autoFit;
            setAutoFit(next);
            if (next) fitToContain();
          }}
          title="Auto-fit on resize"
          active={autoFit}
        >
          {autoFit ? (
            <ToggleRightIcon className="size-3.5" />
          ) : (
            <ToggleLeftIcon className="size-3.5" />
          )}
          <span>Auto</span>
        </ToolbarButton>
      </div>

      {/* Viewport */}
      <div
        ref={viewportRef}
        className={cn(
          "relative flex-1 overflow-hidden",
          "[background-image:repeating-conic-gradient(var(--checker-a)_0%_25%,var(--checker-b)_0%_50%)] [background-size:16px_16px]",
          isDragging ? "cursor-grabbing" : "cursor-default",
        )}
        style={
          {
            "--checker-a": "var(--color-muted, #f0f0f0)",
            "--checker-b": "var(--color-background, #ffffff)",
          } as React.CSSProperties
        }
        tabIndex={0}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
      >
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {iframeSrc && (
            <iframe
              ref={iframeRef}
              sandbox="allow-scripts"
              src={iframeSrc}
              className="border-none"
              style={{
                width: "100%",
                height: "100%",
                transformOrigin: "center center",
                transform: `translate(${translateRef.current.x}px, ${translateRef.current.y}px) scale(${scale})`,
                pointerEvents: isDragging ? "none" : "auto",
              }}
              title={filePath}
            />
          )}
        </div>
      </div>

      {/* Video controls — rendered outside the iframe/transform chain so they stay fixed */}
      {isVideo && videoState && <VideoControls state={videoState} onCommand={sendCommand} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Video controls
// ---------------------------------------------------------------------------

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function VideoControls({
  state,
  onCommand,
}: {
  state: VideoState;
  onCommand: (command: string, value?: number) => void;
}) {
  const seekBarRef = useRef<HTMLDivElement>(null);
  const volumeBarRef = useRef<HTMLDivElement>(null);
  const durationRef = useRef(state.duration);
  durationRef.current = state.duration;

  // Optimistic seek position — tracks the drag position locally so the slider
  // feels instant instead of waiting for the postMessage round-trip.
  const [seekDragRatio, setSeekDragRatio] = useState<number | null>(null);
  const progress =
    seekDragRatio !== null
      ? seekDragRatio
      : state.duration > 0
        ? state.currentTime / state.duration
        : 0;

  const handleSeekDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const bar = seekBarRef.current;
      if (!bar || durationRef.current <= 0) return;

      const seek = (me: MouseEvent | React.MouseEvent) => {
        const rect = bar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (me.clientX - rect.left) / rect.width));
        setSeekDragRatio(ratio);
        onCommand("seek", ratio * durationRef.current);
      };
      seek(e);

      const onMove = (me: MouseEvent) => seek(me);
      const onUp = () => {
        setSeekDragRatio(null);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [onCommand],
  );

  const handleVolumeDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const bar = volumeBarRef.current;
      if (!bar) return;

      const apply = (me: MouseEvent | React.MouseEvent) => {
        const rect = bar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (me.clientX - rect.left) / rect.width));
        onCommand("volume", ratio);
      };
      apply(e);

      const onMove = (me: MouseEvent) => apply(me);
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [onCommand],
  );

  return (
    <div className="border-border bg-background flex shrink-0 flex-col gap-0 border-t">
      {/* Seek bar — fixed-height hit area with thinner visual track (no layout shift) */}
      <div
        ref={seekBarRef}
        className="group relative flex h-3 cursor-pointer items-center"
        onMouseDown={handleSeekDown}
      >
        {/* Track background */}
        <div className="bg-muted absolute inset-x-0 h-1 rounded-full group-hover:h-1.5" />
        {/* Track fill */}
        <div
          className="bg-foreground/50 absolute h-1 rounded-full group-hover:h-1.5"
          style={{ width: `${progress * 100}%` }}
        />
        {/* Scrub handle */}
        <div
          className="bg-foreground absolute top-1/2 size-3 -translate-y-1/2 rounded-full opacity-0 transition-opacity group-hover:opacity-100"
          style={{ left: `calc(${progress * 100}% - 6px)` }}
        />
      </div>

      {/* Controls row */}
      <div className="flex h-7 items-center gap-1.5 px-2 text-xs">
        {/* Play/Pause */}
        <button
          type="button"
          onClick={() => onCommand("toggle")}
          className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
          title={state.playing ? "Pause (Space)" : "Play (Space)"}
        >
          {state.playing ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
        </button>

        {/* Frame step back/forward */}
        <button
          type="button"
          onClick={() => onCommand("step", -FRAME_STEP)}
          className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
          title="Previous frame (\u2190)"
        >
          <ChevronLeftIcon className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onCommand("step", FRAME_STEP)}
          className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
          title="Next frame (\u2192)"
        >
          <ChevronRightIcon className="size-3.5" />
        </button>

        {/* Time */}
        <span className="text-muted-foreground shrink-0 tabular-nums">
          {formatTime(state.currentTime)} / {formatTime(state.duration)}
        </span>

        <div className="flex-1" />

        {/* Repeat toggle */}
        <button
          type="button"
          onClick={() => onCommand("loop")}
          className={cn(
            "shrink-0 rounded px-1 py-0.5 transition-colors",
            state.loop
              ? "bg-primary text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
          title={state.loop ? "Repeat: on" : "Repeat: off"}
        >
          <Repeat1Icon className="size-3.5" />
        </button>

        {/* Playback speed */}
        <select
          value={state.playbackRate}
          onChange={(e) => onCommand("speed", Number(e.target.value))}
          className="text-muted-foreground bg-transparent text-xs tabular-nums outline-none"
          title="Playback speed"
        >
          {PLAYBACK_SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s === 1 ? "1x" : `${s}x`}
            </option>
          ))}
        </select>

        <div className="bg-border mx-0.5 h-3.5 w-px" />

        {/* Mute + Volume slider */}
        <button
          type="button"
          onClick={() => onCommand("mute")}
          className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
          title={state.muted ? "Unmute" : "Mute"}
        >
          {state.muted ? (
            <VolumeXIcon className="size-3.5" />
          ) : (
            <Volume2Icon className="size-3.5" />
          )}
        </button>
        <div
          ref={volumeBarRef}
          className="bg-muted relative h-1 w-16 shrink-0 cursor-pointer rounded-full"
          onMouseDown={handleVolumeDown}
        >
          <div
            className="bg-foreground/60 absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${(state.muted ? 0 : state.volume) * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar button
// ---------------------------------------------------------------------------

function ToolbarButton({
  children,
  onClick,
  title,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "hover:bg-muted flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
        active && "bg-primary text-foreground",
        !active && "text-muted-foreground",
      )}
    >
      {children}
    </button>
  );
}
