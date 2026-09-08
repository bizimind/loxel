import { useCallback, useRef } from "react";

import { NotificationDot } from "@/components/ui/notification-dot";
import { cn } from "@/lib/utils";
import { usePanelBadgeStore } from "@/store/panel-badges";
import type { PanelId } from "@/store/panel-config";
import { getPanelIcon, getPanelLabel } from "@/store/panel-config";
import { togglePanel } from "@/store/tools-bar";
import { useWorktreeToolsBar } from "@/store/worktree-tools-bar";

import { useToolbarZone } from "./ToolbarZone";

/**
 * Self-contained toolbar icon. Only requires `panelId` — everything
 * else (icon, label, active state, zone, click/drag behavior) is
 * derived from the store and the ToolbarZone context.
 */
export function ToolsBarIcon({ panelId }: { panelId: PanelId }) {
  const zone = useToolbarZone();
  const isActive = useWorktreeToolsBar((s) => {
    const active =
      zone === "left"
        ? s.activeLeftPanel
        : zone === "bottom"
          ? s.activeBottomPanel
          : s.activeRightPanel;
    return active === panelId;
  });
  const hasBadge = usePanelBadgeStore((s) => (s.counts[panelId] ?? 0) > 0);

  const Icon = getPanelIcon(panelId);
  const label = getPanelLabel(panelId);
  const dragImageRef = useRef<HTMLDivElement>(null);

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData("text/plain", panelId);
      e.dataTransfer.effectAllowed = "move";
      if (dragImageRef.current) {
        e.dataTransfer.setDragImage(dragImageRef.current, 16, 16);
      }
    },
    [panelId],
  );

  if (!Icon) return null;

  return (
    <div ref={dragImageRef} className="relative">
      <button
        className={cn(
          "corner-superellipse flex size-8 items-center justify-center rounded-2xl transition-colors",
          isActive
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground hover:bg-muted",
        )}
        onClick={() => togglePanel(panelId)}
        draggable
        onDragStart={handleDragStart}
        title={label}
      >
        <Icon className="size-[18px]" />
      </button>
      {hasBadge && !isActive && <NotificationDot />}
    </div>
  );
}
