/**
 * Spatial keyboard focus navigation (`panel.focus.*`, ⌃⇧+arrow by default) across the window's
 * areas, left to right:
 *
 *   worktree sidebar ⇄ left tool bar ⇄ center panels ⇄ right tool bar
 *
 * - Center: left/right walks the active group's tabs, then adjacent groups; up/down moves
 *   between groups. Leaving the center's left or right edge enters the tool bar on that side.
 * - Tool bars: up/down walks the icons (the left bar lists the left zone, then the bottom zone).
 *   Landing on an icon of an expanded zone shows that panel and focuses its content; landing on
 *   an icon of a collapsed zone focuses only the icon, which Enter/Space expands.
 * - Worktree sidebar: up/down moves a cursor over the visible entries; Enter switches. Hidden
 *   worktrees are not rendered in the collapsed rail, so they are skipped there.
 *
 * The current area is derived from DOM focus, so mouse clicks and keyboard navigation agree.
 */

import type { DockviewApi, IDockviewPanel } from "dockview-react";

import { activatePanel, findAdjacentCenterGroup } from "@/store/layout-actions";
import type { MoveDirection } from "@/store/layout-actions";
import type { PanelId } from "@/store/panel-config";
import type { SidebarZone } from "@/store/settings-store";
import {
  getActiveSidebarPanel,
  getCenterApi,
  getSidebarPanelElement,
  getSidebarPanelZone,
  togglePanel,
} from "@/store/tools-bar";
import { getCurrentWorktreeToolsBar } from "@/store/worktree-tools-bar";
import { useWorktreeStore } from "@/store/worktrees";

import {
  FOCUS_AREA_ATTR,
  PANEL_AUTOFOCUS_ATTR,
  SIDEBAR_ENTRY_ATTR,
  TOOLBAR_PANEL_ATTR,
} from "./focus-targets";
import { focusRegisteredPanel } from "./panel-focus";

type BarSide = "left" | "right";

type FocusArea =
  | { kind: "worktrees" }
  | { kind: "bar"; side: BarSide; panelId: PanelId | null }
  | { kind: "center" };

interface BarItem {
  panelId: PanelId;
  zone: SidebarZone;
}

const TABBABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

// ---------------------------------------------------------------------------
// Shared focus helpers
// ---------------------------------------------------------------------------

/** Run after React commits and dockview lays out the change that preceded this call. */
function afterLayout(fn: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/** Focus the autofocus target or first tabbable descendant of `element`, or the element itself. */
function focusWithin(element: HTMLElement): void {
  const target =
    element.querySelector<HTMLElement>(`[${PANEL_AUTOFOCUS_ATTR}]`) ??
    element.querySelector<HTMLElement>(TABBABLE);
  if (target) {
    target.focus();
    return;
  }
  if (!element.hasAttribute("tabindex")) element.tabIndex = -1;
  element.focus();
}

function focusPanelContent(panelId: string, element: HTMLElement | null | undefined): void {
  if (focusRegisteredPanel(panelId)) return;
  if (element) focusWithin(element);
}

// ---------------------------------------------------------------------------
// Area detection
// ---------------------------------------------------------------------------

function sidebarPanelContaining(element: Element): PanelId | null {
  const { leftEntries, bottomEntries, rightEntries } = getCurrentWorktreeToolsBar().getState();
  for (const { panelId } of [...leftEntries, ...bottomEntries, ...rightEntries]) {
    if (getSidebarPanelElement(panelId)?.contains(element)) return panelId;
  }
  return null;
}

function currentArea(): FocusArea {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return { kind: "center" };

  const area = active.closest(`[${FOCUS_AREA_ATTR}]`)?.getAttribute(FOCUS_AREA_ATTR);
  if (area === "worktrees") return { kind: "worktrees" };
  if (area === "left-bar" || area === "right-bar") {
    const panelId = active.closest(`[${TOOLBAR_PANEL_ATTR}]`)?.getAttribute(TOOLBAR_PANEL_ATTR);
    return {
      kind: "bar",
      side: area === "left-bar" ? "left" : "right",
      panelId: (panelId as PanelId | undefined) ?? null,
    };
  }

  const panelId = sidebarPanelContaining(active);
  if (panelId) {
    const zone = getSidebarPanelZone(panelId);
    return { kind: "bar", side: zone === "right" ? "right" : "left", panelId };
  }
  return { kind: "center" };
}

// ---------------------------------------------------------------------------
// Center
// ---------------------------------------------------------------------------

function focusCenterPanel(api: DockviewApi, panel: IDockviewPanel): void {
  activatePanel(api, panel);
  // Activation moves DOM focus via usePanelActivationFocus, but re-activating the already active
  // panel fires no event — focus it explicitly once the activation settles.
  afterLayout(() => focusPanelContent(panel.id, panel.view.content.element));
}

/** Move within the center layout. Returns false at the layout's edge in that direction. */
function moveInCenter(direction: MoveDirection): boolean {
  const api = getCenterApi();
  const active = api?.activePanel;
  if (!api || !active) return false;

  // Horizontal: try sibling tab first.
  if (direction === "right" || direction === "left") {
    const panels = active.group.panels;
    const sibling = panels[panels.indexOf(active) + (direction === "right" ? 1 : -1)];
    if (sibling) {
      focusCenterPanel(api, sibling);
      return true;
    }
  }

  const adjacent = findAdjacentCenterGroup(api, active.group, direction);
  const target = adjacent?.activePanel ?? adjacent?.panels[0];
  if (!target) return false;
  focusCenterPanel(api, target);
  return true;
}

/**
 * Enter the center from its left or right side: the active group if it touches that edge,
 * otherwise the topmost group along it. Focuses that group's active tab.
 */
function enterCenter(from: BarSide): boolean {
  const api = getCenterApi();
  if (!api) return false;
  const groups = api.groups.filter((g) => g.panels.length > 0);
  if (groups.length === 0) return false;

  const rects = new Map(groups.map((g) => [g, g.element.getBoundingClientRect()]));
  const edge =
    from === "left"
      ? Math.min(...groups.map((g) => rects.get(g)!.left))
      : Math.max(...groups.map((g) => rects.get(g)!.right));
  const atEdge = groups.filter((g) => {
    const rect = rects.get(g)!;
    return Math.abs((from === "left" ? rect.left : rect.right) - edge) <= 1;
  });
  const group =
    atEdge.find((g) => g === api.activeGroup) ??
    atEdge.toSorted((a, b) => rects.get(a)!.top - rects.get(b)!.top)[0];
  const panel = group?.activePanel ?? group?.panels[0];
  if (!panel) return false;
  focusCenterPanel(api, panel);
  return true;
}

/** Return keyboard focus to the center's active panel (e.g. Escape from a tool bar). */
export function focusActiveCenterPanel(): void {
  const api = getCenterApi();
  const panel = api?.activePanel;
  if (api && panel) focusCenterPanel(api, panel);
}

// ---------------------------------------------------------------------------
// Tool bars
// ---------------------------------------------------------------------------

function barItems(side: BarSide): BarItem[] {
  const { leftEntries, bottomEntries, rightEntries } = getCurrentWorktreeToolsBar().getState();
  const items = (entries: { panelId: PanelId }[], zone: SidebarZone) =>
    entries.map(({ panelId }) => ({ panelId, zone }));
  return side === "left"
    ? [...items(leftEntries, "left"), ...items(bottomEntries, "bottom")]
    : items(rightEntries, "right");
}

function focusToolbarIcon(panelId: PanelId): void {
  document.querySelector<HTMLElement>(`[${TOOLBAR_PANEL_ATTR}="${CSS.escape(panelId)}"]`)?.focus();
}

/** Focus a sidebar panel's content once it is shown. */
function focusSidebarPanel(panelId: PanelId): void {
  afterLayout(() => focusPanelContent(panelId, getSidebarPanelElement(panelId)));
}

/**
 * Land on a tool bar item, keeping its zone's expanded/collapsed state: in an expanded zone show
 * the panel and focus its content, in a collapsed zone focus only the icon.
 */
function focusBarItem({ panelId, zone }: BarItem): void {
  const visible = getActiveSidebarPanel(zone);
  if (visible === null) {
    focusToolbarIcon(panelId);
    return;
  }
  if (visible !== panelId) togglePanel(panelId);
  focusSidebarPanel(panelId);
}

/** Enter a tool bar: its zone's visible panel if one is open, otherwise its topmost icon. */
function enterBar(side: BarSide): boolean {
  const items = barItems(side);
  const zones: SidebarZone[] = side === "left" ? ["left", "bottom"] : ["right"];
  const open = zones.map(getActiveSidebarPanel).find((id) => id !== null);
  const item = items.find((i) => i.panelId === open) ?? items[0];
  if (!item) return false;
  focusBarItem(item);
  return true;
}

function moveInBar(side: BarSide, from: PanelId | null, step: 1 | -1): void {
  const items = barItems(side);
  const index = items.findIndex((i) => i.panelId === from);
  const target = items[index === -1 ? (step === 1 ? 0 : items.length - 1) : index + step];
  if (target) focusBarItem(target);
}

/**
 * Toggle a sidebar panel and move keyboard focus with it: into the panel when it opens, back to
 * the center when it closes while holding focus.
 */
export function toggleSidebarPanel(panelId: PanelId): void {
  const hadFocus = getSidebarPanelElement(panelId)?.contains(document.activeElement) ?? false;
  togglePanel(panelId);
  const zone = getSidebarPanelZone(panelId);
  if (zone && getActiveSidebarPanel(zone) === panelId) focusSidebarPanel(panelId);
  else if (hadFocus) focusActiveCenterPanel();
}

// ---------------------------------------------------------------------------
// Worktree sidebar
// ---------------------------------------------------------------------------

function sidebarEntries(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[${SIDEBAR_ENTRY_ATTR}]`));
}

function focusSidebarEntry(entry: HTMLElement): void {
  entry.focus();
  entry.scrollIntoView({ block: "nearest" });
}

/** Enter the worktree sidebar on the active worktree's entry. */
function enterWorktrees(): boolean {
  const entries = sidebarEntries();
  const activePath = useWorktreeStore.getState().activeWorktreePath;
  const entry =
    entries.find((e) => e.getAttribute(SIDEBAR_ENTRY_ATTR) === activePath) ?? entries[0];
  if (!entry) return false;
  focusSidebarEntry(entry);
  return true;
}

/** Move the worktree sidebar cursor one entry up or down. */
export function moveWorktreeCursor(step: 1 | -1): void {
  const entries = sidebarEntries();
  const current = document.activeElement?.closest(`[${SIDEBAR_ENTRY_ATTR}]`);
  const index = entries.findIndex((e) => e === current);
  const target = entries[index === -1 ? 0 : index + step];
  if (target) focusSidebarEntry(target);
}

/**
 * Keyboard handling for the worktree sidebar's entries (attach to a container): ↑/↓ move the
 * cursor like ⌃⇧↑/↓, Enter/Space activate the entry (switch worktree), Escape returns focus to
 * the center.
 */
export function handleSidebarEntryKeyDown(e: React.KeyboardEvent): void {
  const entry = e.target;
  if (!(entry instanceof HTMLElement) || !entry.hasAttribute(SIDEBAR_ENTRY_ATTR)) return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  switch (e.key) {
    case "ArrowUp":
    case "ArrowDown":
      e.preventDefault();
      moveWorktreeCursor(e.key === "ArrowUp" ? -1 : 1);
      break;
    case "Enter":
    case " ":
      e.preventDefault();
      entry.click();
      break;
    case "Escape":
      e.preventDefault();
      focusActiveCenterPanel();
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The window's focus areas, left to right. */
const AREA_ORDER = ["worktrees", "left-bar", "center", "right-bar"] as const;
type AreaStop = (typeof AREA_ORDER)[number];

function areaStop(area: FocusArea): AreaStop {
  if (area.kind === "bar") return area.side === "left" ? "left-bar" : "right-bar";
  return area.kind;
}

/** Enter an area from its `from` side. Returns false when the area has nothing to focus. */
function enterArea(stop: AreaStop, from: BarSide): boolean {
  switch (stop) {
    case "worktrees":
      return enterWorktrees();
    case "left-bar":
      return enterBar("left");
    case "center":
      return enterCenter(from);
    case "right-bar":
      return enterBar("right");
    default: {
      const _exhaustive: never = stop;
      throw new Error(`Unknown focus area: ${String(_exhaustive)}`);
    }
  }
}

/** Move keyboard focus one step in `direction` (see module doc for the traversal order). */
export function moveFocus(direction: MoveDirection): void {
  const area = currentArea();

  if (direction === "up" || direction === "down") {
    const step = direction === "down" ? 1 : -1;
    if (area.kind === "center") moveInCenter(direction);
    else if (area.kind === "bar") moveInBar(area.side, area.panelId, step);
    else moveWorktreeCursor(step);
    return;
  }

  if (area.kind === "center" && moveInCenter(direction)) return;

  // Leave the area: enter the next one in that direction that has something to focus.
  const step = direction === "right" ? 1 : -1;
  const from: BarSide = direction === "right" ? "left" : "right";
  for (
    let i = AREA_ORDER.indexOf(areaStop(area)) + step;
    i >= 0 && i < AREA_ORDER.length;
    i += step
  ) {
    if (enterArea(AREA_ORDER[i]!, from)) return;
  }
}
