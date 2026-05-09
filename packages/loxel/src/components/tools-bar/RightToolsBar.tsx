import { useWorktreeToolsBar } from "@/store/worktree-tools-bar";

import { ToolbarZone } from "./ToolbarZone";
import { ToolsBarIcon } from "./ToolsBarIcon";

export function RightToolsBar() {
  const rightEntries = useWorktreeToolsBar((s) => s.rightEntries);

  if (rightEntries.length === 0) return null;

  return (
    <div className="bg-card border-border flex w-10 shrink-0 flex-col border-l">
      <ToolbarZone zone="right" className="flex flex-1 flex-col items-center gap-1 pt-2">
        {rightEntries.map((e) => (
          <ToolsBarIcon key={e.panelId} panelId={e.panelId} />
        ))}
      </ToolbarZone>
    </div>
  );
}
