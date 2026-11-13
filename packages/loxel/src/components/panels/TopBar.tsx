import { PanelLeftCloseIcon, PanelLeftOpenIcon, SettingsIcon } from "lucide-react";

import { NotificationBell } from "@/components/notifications/NotificationBell";
import { useWindowFocused } from "@/hooks/useWindowFocused";
import { useWindowFullScreen } from "@/hooks/useWindowFullScreen";
import { useZoomFactor } from "@/hooks/useZoomFactor";
import { toggleWorktreeSidebar } from "@/lib/focus-navigation";
import { cn } from "@/lib/utils";
import { useUpdateStatus } from "@/queries/use-update-status";
import { deriveProject, useProjectStore } from "@/store/projects";
import { useSettingsStore } from "@/store/settings-store";
import { useWorktreeStore } from "@/store/worktrees";

import { ProjectIcon } from "../projects/ProjectIcon";
import { WorktreeIcon } from "../worktrees/WorktreeIcon";

const isDev = import.meta.env.DEV;
const isElectron = navigator.userAgent.includes("Electron");

// Native-chrome dimensions in screen points. The traffic lights (positioned via
// `trafficLightPosition` in electron/main.ts) ignore page zoom, so the space reserved for
// them and the minimum bar height are divided by the zoom factor to stay fixed.
const TRAFFIC_LIGHTS_INSET_PX = 80;
const BAR_MIN_HEIGHT_PX = 32;

export function TopBar() {
  const isScreenshot = import.meta.env.VITE_SCREENSHOT === "1";
  const windowFocused = useWindowFocused();
  const fullScreen = useWindowFullScreen();
  const zoom = useZoomFactor();
  // macOS hides the traffic lights in native fullscreen (they only appear in the slide-down
  // title bar), so the inset would be an empty gap. Screenshot mode always draws them.
  const trafficLightsInset = isScreenshot || (isElectron && !fullScreen);
  const activeWorktreePath = useWorktreeStore((s) => s.activeWorktreePath);
  const activeProject = useProjectStore((s) => deriveProject(activeWorktreePath, s.projects));
  const activeWorktree = useWorktreeStore((s) => {
    if (!s.activeWorktreePath || !activeProject) return null;
    const wts = s.byProject[activeProject.path]?.worktrees;
    if (!wts) return null;
    return wts.find((w) => w.path === s.activeWorktreePath) ?? null;
  });
  const activeWorktreeName = activeWorktree
    ? (activeWorktree.branch ?? activeWorktree.path.split("/").pop() ?? "worktree")
    : null;

  return (
    <div
      className={cn(
        "border-border relative flex shrink-0 items-center gap-2 border-b px-3 text-sm",
        windowFocused ? "bg-card" : "bg-surface-muted",
      )}
      style={{
        // Grows with zoom-in so the text fits, but never shrinks below the traffic lights.
        height: `max(2rem, ${BAR_MIN_HEIGHT_PX / zoom}px)`,
        ...(trafficLightsInset && { paddingLeft: TRAFFIC_LIGHTS_INSET_PX / zoom }),
        ...(isElectron && { WebkitAppRegion: "drag" }),
      }}
    >
      {isScreenshot && !isElectron && (
        <div className="absolute top-1/2 left-3 flex -translate-y-1/2 items-center gap-[6px]">
          <div className="size-3 rounded-full bg-[#ED6158]" />
          <div className="size-3 rounded-full bg-[#FCC02E]" />
          <div className="size-3 rounded-full bg-[#5FC038]" />
        </div>
      )}
      {/* Worktree sidebar toggle: first in the bar, so it stays put whichever way it goes */}
      <SidebarToggle />

      {/* Brand */}
      <span className="text-foreground font-semibold">Loxel</span>
      {isDev && !isScreenshot && (
        <span className="text-[10px] font-semibold text-red-300">DEV</span>
      )}

      {activeProject && (
        <>
          {/* Divider */}
          <div className="border-border mx-1 h-4 border-l" />

          {/* Project */}
          <div className="text-muted-foreground not-dark:text-foreground/80 flex items-center gap-1.5">
            <ProjectIcon id={activeProject.id} name={activeProject.name} size="xs" />
            <span>{activeProject.name}</span>
          </div>

          {/* Worktree: only linked worktrees are listed, so a regular repo's root shows none */}
          {activeWorktreeName && (
            <>
              <span className="text-muted-foreground mx-0.5 text-xs">/</span>
              <div className="text-muted-foreground flex items-center gap-1.5">
                <WorktreeIcon name={activeWorktreeName} size="xs" />
                <span>{activeWorktreeName}</span>
              </div>
            </>
          )}
        </>
      )}

      {/* Right side — notifications + settings */}
      <div className="ml-auto flex items-center gap-1.5">
        <UpdateIndicator />
        <NotificationBell />
        <button
          aria-label="Settings"
          className="text-muted-foreground hover:text-foreground rounded p-1"
          onClick={() => useSettingsStore.getState().openSettings()}
          style={isElectron ? { WebkitAppRegion: "no-drag" } : undefined}
        >
          <SettingsIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}

function SidebarToggle() {
  const expanded = useProjectStore((s) => s.sidebarExpanded);
  return (
    <button
      className="text-muted-foreground hover:text-foreground hover:bg-muted ml-1.5 shrink-0 rounded p-1 transition-colors"
      onClick={toggleWorktreeSidebar}
      title={expanded ? "Collapse sidebar" : "Expand sidebar"}
      aria-expanded={expanded}
      style={isElectron ? { WebkitAppRegion: "no-drag" } : undefined}
    >
      {expanded ? (
        <PanelLeftCloseIcon className="size-4.5" />
      ) : (
        <PanelLeftOpenIcon className="size-4.5" />
      )}
    </button>
  );
}

function UpdateIndicator() {
  const status = useUpdateStatus();

  const hasUpdate =
    status?.state === "available" || status?.state === "ready" || status?.state === "downloading";
  if (!hasUpdate) return null;

  return (
    <button
      className="text-link hover:text-link/80 mr-1 rounded p-1 text-[10px] font-medium"
      onClick={() => useSettingsStore.getState().openSettings("general")}
      style={isElectron ? { WebkitAppRegion: "no-drag" } : undefined}
      title="Update available"
    >
      Update
    </button>
  );
}
