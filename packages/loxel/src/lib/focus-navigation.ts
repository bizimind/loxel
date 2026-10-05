/**
 * Spatial keyboard focus navigation (`panel.focus.*`, ⌃⇧+arrow by default) across the window's
 * areas, left to right:
 *
 *   worktree sidebar ⇄ left tool bar ⇄ center panels ⇄ right tool bar
 *
 * - Center: arrows move between groups (tabs within a group are ⌘⇧[ ] / ⌃Tab). Leaving the
 *   center's left or right edge enters the tool bar on that side; leaving its bottom edge enters
 *   the bottom zone's panel when that zone is expanded.
 * - Tool bars: up/down walks the icons (the left bar lists the left zone, then the bottom zone).
 *   Landing on an icon of an expanded zone shows that panel and focuses its content; landing on
 *   an icon of a collapsed zone focuses only the icon, which Enter/Space expands. Up from inside
 *   the bottom panel's content returns to the center.
 * - Worktree sidebar: up/down moves a cursor over the visible entries; Enter switches. Hidden
 *   worktrees are not rendered in the collapsed rail, so they are skipped there.
 *
 * The current area is derived from DOM focus, so mouse clicks and keyboard navigation agree.
 */

import type { DockviewApi, IDockviewPanel } from "dockview-react";

import { activatePanel, findAdjacentCenterGroup } from "@/store/layout-actions";
import type { MoveDirection } from "@/store/layout-actions";
import type { PanelId } from "@/store/panel-config";
import { useProjectStore } from "@/store/projects";
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
type CenterEdge = BarSide | "bottom";

type FocusArea =
  | { kind: "worktrees" }
  /** A tool bar icon (`inContent: false`) or the content of its side panel (`inContent: true`). */
  | { kind: "bar"; side: BarSide; panelId: PanelId | null; inContent: boolean }
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
      inContent: false,
    };
  }

  const panelId = sidebarPanelContaining(active);
  if (panelId) {
    const zone = getSidebarPanelZone(panelId);
    return { kind: "bar", side: zone === "right" ? "right" : "left", panelId, inContent: true };
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

/** Move to the adjacent center group. Returns false at the layout's edge in that direction. */
function moveInCenter(direction: MoveDirection): boolean {
  const api = getCenterApi();
  const active = api?.activePanel;
  if (!api || !active) return false;

  const adjacent = findAdjacentCenterGroup(api, active.group, direction);
  const target = adjacent?.activePanel ?? adjacent?.panels[0];
  if (!target) return false;
  focusCenterPanel(api, target);
  return true;
}

/**
 * Enter the center from its left, right or bottom side: the active group if it touches that edge,
 * otherwise the first group along it (topmost, or leftmost along the bottom). Focuses that
 * group's active tab.
 */
function enterCenter(from: CenterEdge): boolean {
  const api = getCenterApi();
  if (!api) return false;
  const groups = api.groups.filter((g) => g.panels.length > 0);
  if (groups.length === 0) return false;

  const rects = new Map(groups.map((g) => [g, g.element.getBoundingClientRect()]));
  const edgeOf = (rect: DOMRect) =>
    from === "left" ? rect.left : from === "right" ? rect.right : rect.bottom;
  const edges = groups.map((g) => edgeOf(rects.get(g)!));
  const edge = from === "left" ? Math.min(...edges) : Math.max(...edges);
  const atEdge = groups.filter((g) => Math.abs(edgeOf(rects.get(g)!) - edge) <= 1);
  const along = (rect: DOMRect) => (from === "bottom" ? rect.left : rect.top);
  const group =
    atEdge.find((g) => g === api.activeGroup) ??
    atEdge.toSorted((a, b) => along(rects.get(a)!) - along(rects.get(b)!))[0];
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

/** Enter the bottom zone's panel from the center, if the zone is expanded. */
function enterBottomPanel(): boolean {
  const visible = getActiveSidebarPanel("bottom");
  if (visible === null) return false;
  focusSidebarPanel(visible);
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

/**
 * Focus the worktree sidebar entry for `path` if it is shown, else the active worktree's entry,
 * else the first entry.
 */
function focusWorktreeEntry(path: string | null): boolean {
  const entries = sidebarEntries();
  const activePath = useWorktreeStore.getState().activeWorktreePath;
  const byPath = (p: string | null) =>
    entries.find((e) => e.getAttribute(SIDEBAR_ENTRY_ATTR) === p);
  const entry = byPath(path) ?? byPath(activePath) ?? entries[0];
  if (!entry) return false;
  focusSidebarEntry(entry);
  return true;
}

/**
 * Collapse or expand the worktree sidebar. When it holds focus, the cursor stays on the same
 * entry — or the active worktree's, if the collapsed rail hides it.
 */
export function toggleWorktreeSidebar(): void {
  const entryPath = document.activeElement
    ?.closest(`[${SIDEBAR_ENTRY_ATTR}]`)
    ?.getAttribute(SIDEBAR_ENTRY_ATTR);
  const hadFocus = currentArea().kind === "worktrees";
  useProjectStore.getState().toggleSidebar();
  if (hadFocus) afterLayout(() => focusWorktreeEntry(entryPath ?? null));
}

/** Enter the worktree sidebar on the active worktree's entry. */
function enterWorktrees(): boolean {
  return focusWorktreeEntry(null);
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
    if (area.kind === "center") {
      if (!moveInCenter(direction) && direction === "down") enterBottomPanel();
    } else if (area.kind === "worktrees") {
      moveWorktreeCursor(step);
    } else {
      // Up from inside the bottom panel returns to the center; on its icon it walks the bar.
      const inBottomPanel =
        area.inContent && area.panelId !== null && getSidebarPanelZone(area.panelId) === "bottom";
      if (!(direction === "up" && inBottomPanel && enterCenter("bottom"))) {
        moveInBar(area.side, area.panelId, step);
      }
    }
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

/**
 * Collapse or expand the area holding focus (`sidebar.toggleFocused`): the worktree sidebar, or
 * the side zone of the focused panel / tool bar icon. Focus stays put — on the same sidebar entry
 * (the active worktree's if the collapsed rail hides it), on the icon of a collapsed zone, or in
 * the content of an expanded one. The center has nothing to collapse.
 */
export function toggleFocusedArea(): void {
  const area = currentArea();
  if (area.kind === "worktrees") {
    toggleWorktreeSidebar();
    return;
  }
  if (area.kind !== "bar" || !area.panelId) return;

  const zone = getSidebarPanelZone(area.panelId);
  if (!zone) return;
  const visible = getActiveSidebarPanel(zone);
  if (visible === null) {
    togglePanel(area.panelId);
    focusSidebarPanel(area.panelId);
    return;
  }
  togglePanel(visible);
  focusToolbarIcon(area.panelId);
}
