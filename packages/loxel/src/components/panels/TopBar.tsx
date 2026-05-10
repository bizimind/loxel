import { useQuery } from "@tanstack/react-query";
import { SettingsIcon } from "lucide-react";

import type { UpdateState } from "@/api/update-model";

import * as api from "@/api/client";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { useWindowFocused } from "@/hooks/useWindowFocused";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/queries/query-keys";
import { deriveProject, useProjectStore } from "@/store/projects";
import { useSettingsStore } from "@/store/settings-store";
import { useWorktreeStore } from "@/store/worktrees";

import { ProjectIcon } from "../projects/ProjectIcon";
import { WorktreeIcon } from "../worktrees/WorktreeIcon";

function LoxelLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" fill="none" className={className}>
      <rect width="100" height="100" rx="20" fill="currentColor" />
      <path
        d="M60.1213 30.5563C58.9498 31.7279 58.9498 33.6274 60.1213 34.799L73.5564 48.234C74.7279 49.4056 76.6274 49.4056 77.799 48.234L82.0416 43.9914C83.2132 42.8198 83.2132 40.9203 82.0416 39.7487L77.0919 34.799C75.9203 33.6274 75.9203 31.7279 77.0919 30.5563L82.0416 25.6066C83.2132 24.435 83.2132 22.5355 82.0416 21.3639L77.799 17.1213C76.6274 15.9497 74.7279 15.9497 73.5564 17.1213L60.1213 30.5563Z"
        fill="#0059FF"
      />
      <path
        d="M41 56C41 58.7614 43.2386 61 46 61H62C64.7614 61 67 63.2386 67 66V80C67 82.7614 64.7614 85 62 85H22C19.2386 85 17 82.7614 17 80V20C17 17.2386 19.2386 15 22 15H36C38.7614 15 41 17.2386 41 20V56Z"
        fill="var(--card)"
      />
      <path
        d="M74.234 30.5563C75.4056 31.7279 75.4056 33.6274 74.234 34.799L60.799 48.234C59.6274 49.4056 57.7279 49.4056 56.5563 48.234L52.3137 43.9914C51.1421 42.8198 51.1421 40.9203 52.3137 39.7487L57.2635 34.799C58.435 33.6274 58.435 31.7279 57.2635 30.5563L52.3137 25.6066C51.1421 24.435 51.1421 22.5355 52.3137 21.3639L56.5563 17.1213C57.7279 15.9497 59.6274 15.9497 60.799 17.1213L74.234 30.5563Z"
        fill="var(--card)"
      />
    </svg>
  );
}

const isDev = import.meta.env.DEV;
const isElectron = navigator.userAgent.includes("Electron");
const electronDragStyle: React.CSSProperties & { WebkitAppRegion: "drag" } = {
  WebkitAppRegion: "drag",
};

export function TopBar() {
  const isScreenshot = import.meta.env.VITE_SCREENSHOT === "1";
  const windowFocused = useWindowFocused();
  const activeWorktreePath = useWorktreeStore((s) => s.activeWorktreePath);
  const activeProject = useProjectStore((s) => deriveProject(activeWorktreePath, s.projects));
  const isBare = activeProject?.isBare ?? false;
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
        "border-border relative flex h-8 shrink-0 items-center gap-2 border-b px-3 text-sm",
        windowFocused ? "bg-card" : "bg-surface-muted",
        (isElectron || isScreenshot) && "pl-20",
      )}
      style={isElectron ? electronDragStyle : undefined}
    >
      {isScreenshot && !isElectron && (
        <div className="absolute top-1/2 left-3 flex -translate-y-1/2 items-center gap-[6px]">
          <div className="size-3 rounded-full bg-[#ED6158]" />
          <div className="size-3 rounded-full bg-[#FCC02E]" />
          <div className="size-3 rounded-full bg-[#5FC038]" />
        </div>
      )}
      {/* Logo + brand */}
      <LoxelLogo className="text-foreground size-4" />
      <span className="text-foreground font-semibold">Loxel</span>
      {isDev && !isScreenshot && (
        <span className="text-[10px] font-semibold text-red-300">DEV</span>
      )}

      {activeProject && (
        <>
          {/* Divider */}
          <div className="border-border mx-1 h-4 border-l" />

          {/* Project */}
          <div className="text-muted-foreground flex items-center gap-1.5">
            <ProjectIcon id={activeProject.id} name={activeProject.name} size="xs" />
            <span>{activeProject.name}</span>
          </div>

          {/* Worktree (bare repos only) */}
          {isBare && activeWorktreeName && (
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
      <div className="ml-auto flex items-center">
        <UpdateIndicator />
        <NotificationBell />
        <button
          className="text-muted-foreground hover:text-foreground rounded p-1"
          onClick={() => useSettingsStore.getState().openSettings()}
          style={isElectron ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
        >
          <SettingsIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

function UpdateIndicator() {
  const { data: status } = useQuery<UpdateState>({
    queryKey: queryKeys.updateStatus(),
    queryFn: api.getUpdateStatus,
    enabled: false, // Only populated by WS bridge, no initial fetch needed
  });

  const hasUpdate =
    status?.state === "available" || status?.state === "ready" || status?.state === "downloading";
  if (!hasUpdate) return null;

  return (
    <button
      className="text-primary hover:text-primary/80 mr-1 rounded p-1 text-[10px] font-medium"
      onClick={() => useSettingsStore.getState().openSettings("general")}
      style={isElectron ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
      title="Update available"
    >
      Update
    </button>
  );
}
