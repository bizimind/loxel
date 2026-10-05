import { useCallback, useRef } from "react";

import { NotificationDot } from "@/components/ui/notification-dot";
import { focusActiveCenterPanel, moveFocus, toggleSidebarPanel } from "@/lib/focus-navigation";
import { toolbarPanelProps } from "@/lib/focus-targets";
import { cn } from "@/lib/utils";
import { usePanelBadgeStore } from "@/store/panel-badges";
import type { PanelId } from "@/store/panel-config";
import { getPanelIcon, getPanelLabel } from "@/store/panel-config";
import { useWorktreeToolsBar } from "@/store/worktree-tools-bar";

import { useToolbarZone } from "./ToolbarZone";

/**
 * Self-contained toolbar icon. Only requires `panelId` — everything
 * else (icon, label, active state, zone, click/drag behavior) is
 * derived from the store and the ToolbarZone context.
 *
 * Keyboard: Enter/Space toggle the panel (focusing it when it opens), ↑/↓ move to the
 * neighbouring icon like ⌃⇧↑/↓, Escape returns focus to the center.
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

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      moveFocus(e.key === "ArrowUp" ? "up" : "down");
    } else if (e.key === "Escape") {
      e.preventDefault();
      focusActiveCenterPanel();
    }
  }, []);

  if (!Icon) return null;

  return (
    <div ref={dragImageRef} className="relative">
      <button
        className={cn(
          "corner-superellipse focus-visible:ring-ring flex size-8 items-center justify-center rounded-2xl transition-colors outline-none focus-visible:ring-2",
          isActive
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground hover:bg-muted",
        )}
        onClick={() => toggleSidebarPanel(panelId)}
        onKeyDown={handleKeyDown}
        draggable
        onDragStart={handleDragStart}
        title={label}
        aria-pressed={isActive}
        {...toolbarPanelProps(panelId)}
      >
        <Icon className="size-[18px]" />
      </button>
      {hasBadge && !isActive && <NotificationDot />}
    </div>
  );
}
