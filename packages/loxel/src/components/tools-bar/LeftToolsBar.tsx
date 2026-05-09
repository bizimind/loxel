import { useWorktreeToolsBar } from "@/store/worktree-tools-bar";

import { ToolbarZone } from "./ToolbarZone";
import { ToolsBarIcon } from "./ToolsBarIcon";

export function LeftToolsBar() {
  const leftEntries = useWorktreeToolsBar((s) => s.leftEntries);
  const bottomEntries = useWorktreeToolsBar((s) => s.bottomEntries);

  return (
    <div className="bg-card border-border flex w-10 shrink-0 flex-col border-r">
      <ToolbarZone zone="left" className="flex flex-1 flex-col items-center gap-1 pt-2">
        {leftEntries.map((e) => (
          <ToolsBarIcon key={e.panelId} panelId={e.panelId} />
        ))}
      </ToolbarZone>

      <div className="bg-border mx-2 my-1 h-px shrink-0" />

      <ToolbarZone zone="bottom" className="flex shrink-0 flex-col items-center gap-1 pb-2">
        {bottomEntries.map((e) => (
          <ToolsBarIcon key={e.panelId} panelId={e.panelId} />
        ))}
      </ToolbarZone>
    </div>
  );
}
