import type { DockviewApi } from "dockview-react";

/** Detect which side a sidebar panel is on relative to the content panel. */
export function detectPanelSide(
  api: DockviewApi,
  sidebarId: string,
  contentId: string,
): "left" | "right" {
  const sidebar = api.getPanel(sidebarId);
  const content = api.getPanel(contentId);
  if (!sidebar || !content) return "left";
  const sidebarLeft = sidebar.group.element.getBoundingClientRect().left;
  const contentLeft = content.group.element.getBoundingClientRect().left;
  return sidebarLeft < contentLeft ? "left" : "right";
}
