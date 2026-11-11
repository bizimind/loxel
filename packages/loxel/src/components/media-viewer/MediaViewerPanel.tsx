import type { DockviewPanelApi } from "dockview-react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PauseIcon,
  PlayIcon,
  Repeat1Icon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { wsClient } from "@/api/client";
import type { WsMessage } from "@/api/ws-protocol";
import { usePanelWorktreePath } from "@/components/dockview/panel-context";
import { type Dimensions, type PanZoomView, viewTransform } from "@/components/pan-zoom/pan-zoom";
import { usePanZoom } from "@/components/pan-zoom/use-pan-zoom";
import { ZoomControls } from "@/components/pan-zoom/ZoomToolbar";
import { getMediaType } from "@/lib/media-extensions";
import { cn } from "@/lib/utils";

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
  const mediaType = getMediaType(filePath);
  const isVideo = mediaType === "video";
  // SVGs are inlined into the frame and may carry their own scripts, so they stay in an opaque
  // origin (no allow-same-origin) and rely on the frame's network-free CSP. Images and videos run
  // only our own inline script and load their bytes from /api/file-raw; that fetch must come from
  // the app's own origin, since the server rejects cross-site subresource loads
  // (src/server/request-origin.ts), so those frames keep the server origin.
  const frameSandbox = mediaType === "svg" ? "allow-scripts" : "allow-scripts allow-same-origin";

  // --- State ---
  const [version, setVersion] = useState(1);
  const [dimensions, setDimensions] = useState<Dimensions | null>(null);
  const [videoState, setVideoState] = useState<VideoState | null>(null);

  // --- Refs ---
  const iframeRef = useRef<HTMLIFrameElement>(null);
  /** The transparency checkerboard, sized and moved with the media (not scaled, so its squares keep
   *  their size at any zoom). */
  const backdropRef = useRef<HTMLDivElement>(null);
  /** The media's on-screen box at zoom 1; the frame page fits the media the same way. */
  const mediaBoxRef = useRef<Dimensions | null>(null);

  const applyView = useCallback((view: PanZoomView) => {
    const iframe = iframeRef.current;
    if (iframe) iframe.style.transform = viewTransform(view);
    const backdrop = backdropRef.current;
    const box = mediaBoxRef.current;
    if (backdrop && box) Object.assign(backdrop.style, backdropStyle(box, view));
  }, []);
  const panZoom = usePanZoom({ contentSize: dimensions, onView: applyView });
  const { viewportRef, viewRef, fitBox: mediaBox, isDragging, wheel } = panZoom;
  mediaBoxRef.current = mediaBox;

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
          // The frame reports the pointer in its own (transformed) coordinates.
          const viewport = viewportRef.current;
          if (!viewport) break;
          const rect = viewport.getBoundingClientRect();
          const iframeRect = iframeRef.current.getBoundingClientRect();
          wheel(msg, {
            x: iframeRect.left - rect.left + msg.clientX,
            y: iframeRect.top - rect.top + msg.clientY,
          });
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
  }, [viewportRef, wheel]);

  // --- Live reload on disk change ---
  useEffect(() => {
    const unsub = wsClient.subscribe((msg: WsMessage) => {
      if (msg.type === "file_content_changed" && msg.data.path === filePath) {
        setVersion((v) => v + 1);
      }
    });
    return unsub;
  }, [filePath]);

  // --- Keyboard ---
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (panZoom.handleKeyDown(e) || !isVideo) return;
      if (e.key === " ") {
        e.preventDefault();
        sendCommand("toggle");
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        sendCommand("step", -FRAME_STEP);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        sendCommand("step", FRAME_STEP);
      }
    },
    [isVideo, panZoom, sendCommand],
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="border-border not-dark:border-input bg-background flex h-8 shrink-0 items-center gap-1 border-b px-2 text-xs">
        <span className="text-foreground dark:text-muted-foreground min-w-0 shrink-0">
          {dimensions ? `${dimensions.width} \u00d7 ${dimensions.height}` : "\u2014"}
        </span>

        <div className="mx-auto" />

        <ZoomControls panZoom={panZoom} />
      </div>

      {/* Viewport */}
      <div
        ref={viewportRef}
        className={cn(
          // A chrome-grey canvas, so the media's own checkerboard and edge stand out
          "bg-card relative flex-1 overflow-hidden",
          isDragging ? "cursor-grabbing" : "cursor-default",
        )}
        tabIndex={0}
        onMouseDown={panZoom.handleMouseDown}
        onDoubleClick={panZoom.handleDoubleClick}
        onKeyDown={handleKeyDown}
      >
        {/* A bordered checkerboard behind the media only, so its edges show where it ends */}
        {mediaBox && (
          <div
            ref={backdropRef}
            className={cn(
              "pointer-events-none absolute top-1/2 left-1/2 box-content border border-[#b4b8c2] shadow-sm dark:border-[#4a4c53]",
              "[background-image:repeating-conic-gradient(var(--checker-a)_0%_25%,var(--checker-b)_0%_50%)] [background-size:16px_16px]",
              // Greys a step off the chrome so transparency reads at a glance.
              "[--checker-a:#dadce1] [--checker-b:var(--color-background)]",
              "dark:[--checker-a:#2c2d32] dark:[--checker-b:#232428]",
            )}
            style={backdropStyle(mediaBox, viewRef.current)}
          />
        )}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {iframeSrc && (
            <iframe
              ref={iframeRef}
              sandbox={frameSandbox}
              src={iframeSrc}
              className="border-none"
              style={{
                width: "100%",
                height: "100%",
                // The frame's document declares `color-scheme: light dark`, which resolves to the
                // browser's preferred scheme (the OS's), not to this element's. Declaring the same
                // here keeps the two equal under either app theme; when they differ, Chromium paints
                // the frame an opaque canvas that hides the checkerboard under transparent pixels.
                colorScheme: "light dark",
                transformOrigin: "center center",
                transform: viewTransform(viewRef.current),
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

/** Size and place the checkerboard over the media's zoomed, panned box (border outside it). */
function backdropStyle(
  box: Dimensions,
  { x, y, scale }: PanZoomView,
): Pick<React.CSSProperties, "width" | "height" | "transform"> {
  return {
    width: `${box.width * scale}px`,
    height: `${box.height * scale}px`,
    transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`,
  };
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
