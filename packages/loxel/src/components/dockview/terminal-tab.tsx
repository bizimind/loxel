import type { IDockviewPanelHeaderProps } from "dockview-react";
import { HistoryIcon, SquareTerminalIcon } from "lucide-react";

import { type AgentOrigin, agentName } from "@/api/agent-terminal-model";
import { localServerId } from "@/api/local-server";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { NotificationDot } from "@/components/ui/notification-dot";
import { pathName } from "@/lib/project-file-helpers";
import { confirmRestartTerminal } from "@/lib/restart-terminal";
import { useRunningTerminals } from "@/queries/use-running-terminals";

import { getPanelServer } from "./panel-context";
import { Tab, usePanelTitle } from "./tab";
import { usePanelNotificationDot } from "./use-panel-notification-dot";

/** The tooltip of a terminal running in a terminal host of another Loxel version. */
export const OTHER_HOST_TOOLTIP =
  "This terminal runs on the terminal host of another Loxel version. Restart Terminal (right-click) starts a new shell here on the current one.";

/**
 * Where a terminal a coding agent started came from: the agent and, when it ran in a Loxel
 * terminal, that terminal (by its tab title when it is open, `sourceTitle`) and its worktree.
 */
export function originTooltip(origin: AgentOrigin, sourceTitle: string | undefined): string {
  const started = `Started by ${agentName(origin)}`;
  if (!origin.terminalId) return started;
  const terminal = sourceTitle ? `the terminal "${sourceTitle}"` : "a terminal";
  const worktree = origin.worktreePath ? pathName(origin.worktreePath) : "Home";
  return `${started} from ${terminal} in ${worktree}`;
}

export function TerminalTab(
  props: IDockviewPanelHeaderProps<{ terminalId: string; origin?: AgentOrigin }>,
) {
  const { terminalId, origin } = props.params;
  const showDot = usePanelNotificationDot(props, terminalId);
  const panel = props.containerApi.getPanel(props.api.id);
  const server = panel ? getPanelServer(panel) : localServerId();
  const title = usePanelTitle(props.api);
  const otherHostBuild =
    useRunningTerminals()?.find((terminal) => terminal.id === terminalId)?.otherHostBuild ?? false;

  const sourceTitle = origin?.terminalId
    ? props.containerApi.getPanel(`terminal-${origin.terminalId}`)?.title
    : undefined;
  const tooltips = [
    ...(origin ? [originTooltip(origin, sourceTitle)] : []),
    ...(otherHostBuild ? [OTHER_HOST_TOOLTIP] : []),
  ];
  const tooltip = tooltips.length > 0 ? tooltips.join("\n\n") : undefined;

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
      titleTooltip={tooltip}
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
          <ContextMenuItem
            onClick={() => void confirmRestartTerminal(props.api, terminalId, server)}
          >
            Restart Terminal
          </ContextMenuItem>
        ) : undefined
      }
    />
  );
}
