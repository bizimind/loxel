import type { IDockviewPanelHeaderProps } from "dockview-react";
import { HistoryIcon, SquareTerminalIcon } from "lucide-react";

import { ContextMenuItem } from "@/components/ui/context-menu";
import { NotificationDot } from "@/components/ui/notification-dot";
import { confirmRestartTerminal } from "@/lib/restart-terminal";
import { useRunningTerminals } from "@/queries/use-running-terminals";

import { Tab, usePanelTitle } from "./tab";
import { usePanelNotificationDot } from "./use-panel-notification-dot";

/** The tooltip of a terminal running in a terminal host of another Loxel version. */
export const OTHER_HOST_TOOLTIP =
  "This terminal runs on the terminal host of another Loxel version. Restart Terminal (right-click) starts a new shell here on the current one.";

export function TerminalTab(props: IDockviewPanelHeaderProps<{ terminalId: string }>) {
  const terminalId = props.params.terminalId;
  const showDot = usePanelNotificationDot(props.api, terminalId);
  const title = usePanelTitle(props.api);
  const otherHostBuild =
    useRunningTerminals()?.find((terminal) => terminal.id === terminalId)?.otherHostBuild ?? false;

  return (
    <Tab
      api={props.api}
      icon={
        <span className="relative shrink-0">
          <SquareTerminalIcon className="size-3.5" />
          {showDot && <NotificationDot />}
        </span>
      }
      title={title || "Terminal"}
      onRename={(newName) => props.api.setTitle(newName)}
      titleTooltip={otherHostBuild ? OTHER_HOST_TOOLTIP : undefined}
      trailing={
        otherHostBuild ? (
          <HistoryIcon
            className="text-muted-foreground size-3 shrink-0"
            aria-label="Runs on another version's terminal host"
          >
            <title>{OTHER_HOST_TOOLTIP}</title>
          </HistoryIcon>
        ) : null
      }
      contextMenuItems={
        otherHostBuild ? (
          <ContextMenuItem onClick={() => void confirmRestartTerminal(props.api, terminalId)}>
            Restart Terminal
          </ContextMenuItem>
        ) : undefined
      }
    />
  );
}
