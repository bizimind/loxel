/**
 * Restart Terminal: end a terminal panel's shell and start a new one in the same panel, with the
 * same starting directory, in the current terminal host. Offered for a terminal that runs in a
 * terminal host of another Loxel version (see docs/TERMINAL_HOST.md#generations).
 */
import type { DockviewPanelApi } from "dockview-react";

import { wsClient } from "@/api/client";
import { frontendLog } from "@/lib/frontend-logger";
import { usePanelNotificationStore } from "@/store/panel-notifications";
import { getCurrentWorktreeToolsBar } from "@/store/worktree-tools-bar";

const uiLog = frontendLog.child("ui");

/**
 * The new shell gets a new terminal ID, so output of the old one still on its way never reaches
 * the new xterm. The panel's other parameters, and so its spawn target, stay as they are.
 */
export function restartTerminal(api: DockviewPanelApi, terminalId: string): void {
  const nextId = crypto.randomUUID();
  wsClient.send({ type: "terminal_destroy", id: terminalId });
  usePanelNotificationStore.getState().unregisterPanel(terminalId);
  const toolsBar = getCurrentWorktreeToolsBar().getState();
  toolsBar.removeTerminal(api.id);
  toolsBar.addTerminal({ id: api.id, title: api.title ?? "Terminal", terminalId: nextId });
  // The panel's Terminal sees the new ID, detaches its xterm from the old session and attaches a
  // fresh one, which spawns the new shell.
  api.updateParameters({ terminalId: nextId });
  uiLog.info("Terminal restarted", { panelId: api.id, from: terminalId, to: nextId });
}
