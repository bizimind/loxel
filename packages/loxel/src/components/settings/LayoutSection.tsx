import { GripVerticalIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ALLOWED_ZONES, SIDEBAR_ZONES, getPanelIcon, getPanelLabel } from "@/store/panel-config";
import {
  type SidebarPanelId,
  type SidebarZone,
  type ZoneDefault,
  useSettingsStore,
} from "@/store/settings-store";

const ZONES: { zone: SidebarZone; label: string; sizeLabel: string; sizePlaceholder: string }[] = [
  { zone: "left", label: "Left Panel", sizeLabel: "W", sizePlaceholder: "250" },
  { zone: "bottom", label: "Bottom Panel", sizeLabel: "H", sizePlaceholder: "300" },
  { zone: "right", label: "Right Panel", sizeLabel: "W", sizePlaceholder: "320" },
];

export function LayoutSection() {
  const zoneDefaults = useSettingsStore((s) => s.layout.zoneDefaults);
  const zonePanelOrder = useSettingsStore((s) => s.layout.zonePanelOrder);
  const setZoneDefault = useSettingsStore((s) => s.setZoneDefault);
  const movePanel = useSettingsStore((s) => s.movePanel);

  const handleSizeChange = useCallback(
    (zone: SidebarZone, value: string) => {
      const size = Number.parseInt(value, 10);
      if (!Number.isFinite(size) || size < 0) return;

      if (size === 0) {
        setZoneDefault(zone, false);
      } else {
        const current = zoneDefaults[zone];
        const activePanel = current
          ? current.activePanel
          : (zonePanelOrder[zone][0] ?? ("" as SidebarPanelId));
        setZoneDefault(zone, { size, activePanel });
      }
    },
    [zoneDefaults, zonePanelOrder, setZoneDefault],
  );

  // Keep activePanel in sync with the first panel in the zone
  const getZoneSize = (zone: SidebarZone): number => {
    const zd = zoneDefaults[zone];
    return zd ? zd.size : 0;
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-foreground text-sm font-medium">Layout</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          Drag panels to reorder or move between zones. The top panel in each zone opens by default.
          Set size to 0 to keep a zone closed. Settings affect new worktree layouts only.
        </p>
      </div>

      <PanelPlacementDnd
        zonePanelOrder={zonePanelOrder}
        zoneDefaults={zoneDefaults}
        movePanel={movePanel}
        getZoneSize={getZoneSize}
        onSizeChange={handleSizeChange}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unified drag & drop with inline zone config
// ---------------------------------------------------------------------------

interface DropPosition {
  zone: SidebarZone;
  index: number;
}

interface PanelPlacementDndProps {
  zonePanelOrder: Record<SidebarZone, SidebarPanelId[]>;
  zoneDefaults: Record<SidebarZone, ZoneDefault | false>;
  movePanel: (panelId: SidebarPanelId, targetZone: SidebarZone, insertIndex: number) => void;
  getZoneSize: (zone: SidebarZone) => number;
  onSizeChange: (zone: SidebarZone, value: string) => void;
}

function PanelPlacementDnd({
  zonePanelOrder,
  movePanel,
  getZoneSize,
  onSizeChange,
}: PanelPlacementDndProps) {
  const [draggedPanel, setDraggedPanel] = useState<SidebarPanelId | null>(null);
  const [dropPos, setDropPos] = useState<DropPosition | null>(null);
  const zoneCounters = useRef<Record<string, number>>({});

  /** Whether the currently dragged panel is allowed in the given zone. */
  const isZoneAllowed = useCallback(
    (zone: SidebarZone): boolean => {
      if (!draggedPanel) return false;
      const allowed = ALLOWED_ZONES[draggedPanel];
      return !allowed || allowed.includes(zone);
    },
    [draggedPanel],
  );

  const handleDragStart = useCallback((e: React.DragEvent, panelId: SidebarPanelId) => {
    setDraggedPanel(panelId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", panelId);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedPanel(null);
    setDropPos(null);
    zoneCounters.current = {};
  }, []);

  const handleItemDragOver = useCallback(
    (e: React.DragEvent, zone: SidebarZone, index: number) => {
      e.preventDefault();
      e.stopPropagation();
      if (!draggedPanel) return;

      if (!isZoneAllowed(zone)) {
        e.dataTransfer.dropEffect = "none";
        return;
      }

      const rect = e.currentTarget.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const insertIndex = e.clientY < midY ? index : index + 1;

      setDropPos({ zone, index: insertIndex });
      e.dataTransfer.dropEffect = "move";
    },
    [draggedPanel, isZoneAllowed],
  );

  const handleZoneDragEnter = useCallback(
    (e: React.DragEvent, zone: SidebarZone) => {
      e.preventDefault();
      zoneCounters.current[zone] = (zoneCounters.current[zone] ?? 0) + 1;
      if (draggedPanel && zonePanelOrder[zone].length === 0 && isZoneAllowed(zone)) {
        setDropPos({ zone, index: 0 });
      }
    },
    [draggedPanel, zonePanelOrder, isZoneAllowed],
  );

  const handleZoneDragLeave = useCallback(
    (zone: SidebarZone) => {
      zoneCounters.current[zone] = (zoneCounters.current[zone] ?? 1) - 1;
      if (zoneCounters.current[zone] <= 0) {
        zoneCounters.current[zone] = 0;
        if (dropPos?.zone === zone) setDropPos(null);
      }
    },
    [dropPos],
  );

  const handleZoneDragOver = useCallback(
    (e: React.DragEvent, zone: SidebarZone) => {
      e.preventDefault();
      if (!isZoneAllowed(zone)) {
        e.dataTransfer.dropEffect = "none";
        return;
      }
      if (draggedPanel && zonePanelOrder[zone].length === 0) {
        setDropPos({ zone, index: 0 });
      }
      e.dataTransfer.dropEffect = "move";
    },
    [draggedPanel, zonePanelOrder, isZoneAllowed],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const panelId = e.dataTransfer.getData("text/plain") as SidebarPanelId;
      if (!panelId || !dropPos) return;

      const allowed = ALLOWED_ZONES[panelId];
      if (allowed && !allowed.includes(dropPos.zone)) {
        handleDragEnd();
        return;
      }

      let adjustedIndex = dropPos.index;
      const sourceZone = SIDEBAR_ZONES.find((z) => zonePanelOrder[z].includes(panelId));
      if (sourceZone === dropPos.zone) {
        const currentIdx = zonePanelOrder[sourceZone].indexOf(panelId);
        if (currentIdx < adjustedIndex) adjustedIndex--;
        if (currentIdx === adjustedIndex) {
          handleDragEnd();
          return;
        }
      }

      movePanel(panelId, dropPos.zone, adjustedIndex);
      handleDragEnd();
    },
    [dropPos, zonePanelOrder, movePanel, handleDragEnd],
  );

  return (
    <div className="rounded-md bg-[var(--surface-2)]">
      {ZONES.map(({ zone, label, sizeLabel, sizePlaceholder }, zoneIdx) => {
        const panels = zonePanelOrder[zone];
        const size = getZoneSize(zone);
        const isOpen = size > 0;
        const isZoneHighlight =
          dropPos?.zone === zone &&
          draggedPanel &&
          !panels.includes(draggedPanel) &&
          isZoneAllowed(zone);

        return (
          <div
            key={zone}
            onDragEnter={(e) => handleZoneDragEnter(e, zone)}
            onDragLeave={() => handleZoneDragLeave(zone)}
            onDragOver={(e) => handleZoneDragOver(e, zone)}
            onDrop={handleDrop}
            className={cn(
              "transition-colors",
              zoneIdx > 0 && "border-border/50 border-t",
              isZoneHighlight && panels.length === 0 && "bg-primary/10",
            )}
          >
            {/* Zone header: label + size input */}
            <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
              <span className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
                {label}
              </span>
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground text-[10px]">{sizeLabel}</span>
                <Input
                  type="number"
                  value={size}
                  onChange={(e) => onSizeChange(zone, e.target.value)}
                  min={0}
                  max={800}
                  placeholder={sizePlaceholder}
                  className="h-5 w-14 px-1.5 text-center text-[10px]"
                />
              </div>
            </div>

            {/* Panel list */}
            <div className="flex flex-col px-2 pb-2">
              {panels.length === 0 && (
                <div className="text-muted-foreground/50 px-1 py-2 text-center text-[10px] italic">
                  Drop panels here
                </div>
              )}
              {panels.map((panelId, itemIdx) => {
                const Icon = getPanelIcon(panelId);
                const isDragging = draggedPanel === panelId;
                const isDefault = itemIdx === 0 && isOpen;
                const showIndicatorBefore =
                  dropPos?.zone === zone && dropPos.index === itemIdx && draggedPanel !== panelId;
                const showIndicatorAfter =
                  dropPos?.zone === zone &&
                  dropPos.index === itemIdx + 1 &&
                  itemIdx === panels.length - 1 &&
                  draggedPanel !== panelId;

                return (
                  <div key={panelId}>
                    {showIndicatorBefore && <DropIndicator />}
                    <div
                      draggable
                      onDragStart={(e) => handleDragStart(e, panelId)}
                      onDragEnd={handleDragEnd}
                      onDragOver={(e) => handleItemDragOver(e, zone, itemIdx)}
                      className={cn(
                        "flex cursor-grab items-center gap-2 rounded px-2 py-1.5 text-xs active:cursor-grabbing",
                        isDragging && "opacity-30",
                      )}
                    >
                      <GripVerticalIcon className="text-muted-foreground/50 size-3 shrink-0" />
                      {Icon && <Icon className="text-muted-foreground size-3.5 shrink-0" />}
                      <span className="text-foreground">{getPanelLabel(panelId) ?? panelId}</span>
                      {isDefault && (
                        <span className="bg-primary text-primary-foreground rounded px-1.5 py-0.5 text-[9px] font-medium">
                          Default
                        </span>
                      )}
                    </div>
                    {showIndicatorAfter && <DropIndicator />}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DropIndicator() {
  return (
    <div className="flex items-center px-2 py-0.5">
      <div className="bg-primary h-0.5 w-full rounded-full" />
    </div>
  );
}
