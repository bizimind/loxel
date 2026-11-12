/**
 * A Mermaid diagram opened full size from its markdown preview: a near-full-window dialog with
 * the media viewer's zoom and pan (`usePanZoom`) and Copy as SVG / PNG. It shows the variant for
 * the app's theme and never touches the markdown source.
 */
import { CopyIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  copyDiagram,
  type DiagramCopyFormat,
  surfaceColor,
} from "@/components/editor/mermaid-export";
import { type MermaidDiagram, renderMermaidDiagram } from "@/components/editor/mermaid-preview";
import { type PanZoomView, viewTransform } from "@/components/pan-zoom/pan-zoom";
import { usePanZoom } from "@/components/pan-zoom/use-pan-zoom";
import { ToolbarButton, ToolbarSeparator, ZoomControls } from "@/components/pan-zoom/ZoomToolbar";
import { DialogShell } from "@/components/ui/dialog-shell";
import { frontendLog } from "@/lib/frontend-logger";
import { useUIStore } from "@/store/ui";

interface MermaidDiagramViewerProps {
  /** The diagram's Mermaid source. */
  source: string;
  onClose: () => void;
}

export function MermaidDiagramViewer({ source, onClose }: MermaidDiagramViewerProps) {
  const darkMode = useUIStore((s) => s.darkMode);
  const [diagram, setDiagram] = useState<MermaidDiagram | null>(null);
  const [failed, setFailed] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    renderMermaidDiagram(source).then(
      (rendered) => {
        if (cancelled) return;
        // Without a viewBox there is no size to fit; mermaid always emits one.
        if (rendered.size) setDiagram(rendered);
        else setFailed(true);
      },
      (error: unknown) => {
        frontendLog.child("ui").error("Failed to render diagram for the viewer", { error });
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source]);

  const applyView = useCallback((view: PanZoomView) => {
    if (boxRef.current) boxRef.current.style.transform = viewTransform(view);
  }, []);
  const panZoom = usePanZoom({ contentSize: diagram?.size ?? null, onView: applyView });
  const { viewportRef, viewRef, fitBox } = panZoom;

  // The dialog focuses its first button when shown (its effect runs before this one); focus the
  // viewport instead so the zoom keys work at once.
  useEffect(() => {
    viewportRef.current?.focus();
  }, [viewportRef]);

  const copy = (format: DiagramCopyFormat) => {
    const svg = boxRef.current?.querySelector("svg");
    const viewport = viewportRef.current;
    if (svg && viewport) void copyDiagram(svg, format, surfaceColor(viewport));
  };

  const size = diagram?.size;
  return (
    <DialogShell
      open
      onCancel={onClose}
      className="flex h-[calc(100vh-4rem)] max-h-none w-[calc(100vw-4rem)] max-w-none flex-col overflow-hidden"
    >
      <div
        className="flex h-full min-h-0 flex-col"
        onKeyDown={(e) => {
          panZoom.handleKeyDown(e);
        }}
      >
        <div className="border-border not-dark:border-input bg-background flex h-8 shrink-0 items-center gap-1 border-b px-2 text-xs">
          <span className="text-foreground dark:text-muted-foreground min-w-0 shrink-0">
            Mermaid diagram
            {size && ` · ${Math.round(size.width)} × ${Math.round(size.height)}`}
          </span>
          <div className="mx-auto" />
          <ZoomControls panZoom={panZoom} />
          <ToolbarSeparator />
          <ToolbarButton onClick={() => copy("svg")} title="Copy as SVG">
            <CopyIcon className="size-3.5" />
            <span>SVG</span>
          </ToolbarButton>
          <ToolbarButton onClick={() => copy("png")} title="Copy as PNG">
            <CopyIcon className="size-3.5" />
            <span>PNG</span>
          </ToolbarButton>
          <ToolbarSeparator />
          <ToolbarButton onClick={onClose} title="Close (Esc)">
            <XIcon className="size-3.5" />
          </ToolbarButton>
        </div>
        <div
          ref={viewportRef}
          tabIndex={0}
          className={`relative min-h-0 flex-1 overflow-hidden outline-none ${panZoom.isDragging ? "cursor-grabbing" : "cursor-grab"}`}
          style={{ backgroundColor: "var(--editor-surface)" }}
          onMouseDown={panZoom.handleMouseDown}
          onDoubleClick={panZoom.handleDoubleClick}
        >
          {failed && (
            <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
              Could not render the diagram
            </div>
          )}
          {diagram && fitBox && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div
                ref={boxRef}
                className="shrink-0 [&>svg]:h-full [&>svg]:w-full [&>svg]:max-w-none!"
                style={{
                  width: fitBox.width,
                  height: fitBox.height,
                  transformOrigin: "center center",
                  transform: viewTransform(viewRef.current),
                }}
                // Sanitized by renderMermaidDiagram, from mermaid's strict-mode output.
                // oxlint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: darkMode ? diagram.dark : diagram.light }}
              />
            </div>
          )}
        </div>
      </div>
    </DialogShell>
  );
}
