/** Toolbar pieces for {@link usePanZoom} views, so every zoomable view has the same controls. */
import {
  Maximize2Icon,
  MinusIcon,
  PlusIcon,
  ScanIcon,
  ToggleLeftIcon,
  ToggleRightIcon,
} from "lucide-react";

import { ZOOM_STEP } from "@/components/pan-zoom/pan-zoom";
import type { usePanZoom } from "@/components/pan-zoom/use-pan-zoom";
import { cn } from "@/lib/utils";

type PanZoom = ReturnType<typeof usePanZoom>;

/** Zoom out / percentage / zoom in, Fit, 1:1, and auto-fit on resize. */
export function ZoomControls({ panZoom }: { panZoom: PanZoom }) {
  return (
    <>
      <ToolbarButton onClick={() => panZoom.zoomBy(1 / ZOOM_STEP)} title="Zoom out (-)">
        <MinusIcon className="size-3.5" />
      </ToolbarButton>
      <span className="text-foreground dark:text-muted-foreground w-10 text-center tabular-nums">
        {panZoom.zoomPercent}%
      </span>
      <ToolbarButton onClick={() => panZoom.zoomBy(ZOOM_STEP)} title="Zoom in (+)">
        <PlusIcon className="size-3.5" />
      </ToolbarButton>

      <ToolbarSeparator />

      <ToolbarButton onClick={panZoom.fit} title="Fit to panel (0)">
        <ScanIcon className="size-3.5" />
        <span>Fit</span>
      </ToolbarButton>
      <ToolbarButton onClick={panZoom.actualSize} title="Actual size">
        <Maximize2Icon className="size-3.5" />
        <span>1:1</span>
      </ToolbarButton>

      <ToolbarSeparator />

      <ToolbarButton
        onClick={panZoom.toggleAutoFit}
        title="Auto-fit on resize"
        active={panZoom.autoFit}
      >
        {panZoom.autoFit ? (
          <ToggleRightIcon className="size-3.5" />
        ) : (
          <ToggleLeftIcon className="size-3.5" />
        )}
        <span>Auto</span>
      </ToolbarButton>
    </>
  );
}

export function ToolbarButton({
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
        // Light: on toggles take the accent text, idle buttons the full text color (their thin icons
        // read as grey at toolbar size).
        active && "bg-primary text-link dark:text-foreground",
        !active && "text-foreground dark:text-muted-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** Divider between toolbar groups (a step darker than the border in light). */
export function ToolbarSeparator() {
  return <div className="bg-muted-foreground/80 dark:bg-border mx-1 h-3.5 w-px" />;
}
