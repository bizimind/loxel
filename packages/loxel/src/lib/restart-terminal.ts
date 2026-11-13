/**
 * Restart Terminal: end a terminal panel's shell and start a new one in the same panel, with the
 * same starting directory, in the current terminal host. Offered for a terminal that runs in a
 * terminal host of another Loxel version (see docs/TERMINAL_HOST.md#generations).
 */
import type { DockviewPanelApi } from "dockview-react";

import * as api from "@/api/client";
import { requestConfirmation } from "@/components/ui/confirm-dialog-host";
import { frontendLog } from "@/lib/frontend-logger";
import { usePanelNotificationStore } from "@/store/panel-notifications";
import { getCurrentWorktreeToolsBar } from "@/store/worktree-tools-bar";

const uiLog = frontendLog.child("ui");

/**
 * Restart the panel's terminal once the user confirms: the shell ends with whatever runs in it,
 * which the question names when the terminal's host can tell.
 */
export async function confirmRestartTerminal(
  panel: DockviewPanelApi,
  terminalId: string,
): Promise<void> {
  let program: string | null | undefined;
  try {
    const running = await api.getRunningTerminals({ programs: true });
    program = running.find((terminal) => terminal.id === terminalId)?.program;
  } catch (err) {
    uiLog.warn("Could not read the terminal's foreground program", { error: err });
  }
  const confirmed = await requestConfirmation({
    title: "Restart Terminal?",
    description:
      typeof program === "string"
        ? `${program} is running in it and ends with the shell. A new shell starts in the same folder.`
        : "The shell ends, with anything running in it, and a new one starts in the same folder.",
    confirmLabel: "Restart",
    destructive: true,
  });
  if (confirmed) restartTerminal(panel, terminalId);
}

/**
 * The new shell gets a new terminal ID, so output of the old one still on its way never reaches
 * the new xterm. The panel's other parameters, and so its spawn target, stay as they are.
 */
export function restartTerminal(panel: DockviewPanelApi, terminalId: string): void {
  const nextId = crypto.randomUUID();
  api.wsClient.send({ type: "terminal_destroy", id: terminalId });
  usePanelNotificationStore.getState().unregisterPanel(terminalId);
  const toolsBar = getCurrentWorktreeToolsBar().getState();
  toolsBar.removeTerminal(panel.id);
  toolsBar.addTerminal({ id: panel.id, title: panel.title ?? "Terminal", terminalId: nextId });
  // The panel's Terminal sees the new ID, detaches its xterm from the old session and attaches a
  // fresh one, which spawns the new shell.
  panel.updateParameters({ terminalId: nextId });
  uiLog.info("Terminal restarted", { panelId: panel.id, from: terminalId, to: nextId });
}
