import type { DockviewPanelApi } from "dockview-react";

/**
 * Which view a terminal panel shows of a coding agent running in it: the agent overlay, or the raw
 * terminal. Kept in the panel's params, so the layout remembers it. Unset means the overlay, shown
 * as soon as an agent session is detected in the terminal.
 */
export type TerminalView = "agent" | "terminal";

export interface TerminalViewParams {
  view?: TerminalView;
}

export function terminalView(params: TerminalViewParams): TerminalView {
  return params.view ?? "agent";
}

export function setTerminalView(api: DockviewPanelApi, view: TerminalView): void {
  api.updateParameters({ view });
}
