/**
 * Per-worktree stacks of closed center tabs, for the `panel.reopenClosed` action.
 *
 * Tabs are recorded by `closeCenterTab`, which every user-facing close path goes through. A tab
 * removed for another reason (its file moved or was deleted, `loxel --replace`, a layout swap) is
 * not one the user closed, so it closes through dockview directly and is not recorded.
 *
 * Kept in memory per window, like worktree history, and purged with the worktree's other stores.
 */
import type {
  AddPanelOptions,
  DockviewPanelApi,
  IDockviewPanel,
  PanelOptions,
} from "dockview-react";

import { getCenterPanelDef } from "./panel-config";
import { getCenterApi, getCenterApiWorktree } from "./tools-bar";
import { createWorktreeStore } from "./worktree-store";

/** Stacks are capped; the oldest tabs are dropped. */
const MAX_CLOSED_TABS = 50;

/** What it takes to open a closed tab again, and where it was. */
export interface ClosedTab extends PanelOptions, Pick<AddPanelOptions, "renderer"> {
  groupId: string;
  index: number;
}

const { getStore } = createWorktreeStore<{ tabs: ClosedTab[] }>(() => ({ tabs: [] }));

/** Params for reopening a panel from state its dockview params don't hold, by panel id. */
const liveParams = new Map<string, () => Record<string, unknown>>();

/** Register `getParams` for `panelId`, read when its tab closes. Returns an unregister function. */
export function registerClosedTabParams(
  panelId: string,
  getParams: () => Record<string, unknown>,
): () => void {
  liveParams.set(panelId, getParams);
  return () => {
    if (liveParams.get(panelId) === getParams) liveParams.delete(panelId);
  };
}

function toClosedTab(panel: IDockviewPanel): ClosedTab | null {
  const def = getCenterPanelDef(panel.id);
  if (!def) return null;
  // A past jump's position and move notice are not part of the tab's state any more.
  const params = { ...panel.params };
  delete params.line;
  delete params.column;
  delete params.movedFrom;
  return {
    id: panel.id,
    component: def.component,
    tabComponent: def.tabComponent,
    title: panel.title,
    params: { ...params, ...liveParams.get(panel.id)?.() },
    renderer: panel.api.renderer,
    groupId: panel.group.id,
    index: panel.group.panels.indexOf(panel),
  };
}

/** Close a center tab at the user's request, so it can be reopened. */
export function closeCenterTab(api: DockviewPanelApi): void {
  const worktreePath = getCenterApiWorktree();
  const panel = getCenterApi()?.getPanel(api.id);
  const closed = panel && toClosedTab(panel);
  if (worktreePath && closed) {
    const { tabs } = getStore(worktreePath).getState();
    getStore(worktreePath).setState({ tabs: [...tabs, closed].slice(-MAX_CLOSED_TABS) });
  }
  api.close();
}

/**
 * Remove and return the worktree's most recently closed tab that isn't open. A tab already open
 * again (its file was reopened another way, a singleton was recreated) has nothing to bring back.
 */
export function takeLastClosedTab(
  worktreePath: string,
  isOpen: (panelId: string) => boolean,
): ClosedTab | undefined {
  const store = getStore(worktreePath);
  const tabs = [...store.getState().tabs];
  let tab = tabs.pop();
  while (tab && isOpen(tab.id)) tab = tabs.pop();
  store.setState({ tabs });
  return tab;
}

/**
 * Point closed tabs at the group that replaced their removed one, shifting their indexes by where
 * the first of them landed so they keep their order around it.
 */
export function retargetClosedTabs(
  worktreePath: string,
  fromId: string,
  toId: string,
  indexOffset: number,
): void {
  const store = getStore(worktreePath);
  store.setState({
    tabs: store
      .getState()
      .tabs.map((t) =>
        t.groupId === fromId ? { ...t, groupId: toId, index: t.index + indexOffset } : t,
      ),
  });
}

/**
 * A group was removed. Its closed tabs stop naming its id, which dockview reuses for later groups,
 * and share a name no group has, so they still reopen together.
 */
export function forgetClosedTabGroup(worktreePath: string, groupId: string): void {
  retargetClosedTabs(worktreePath, groupId, `removed-${crypto.randomUUID()}`, 0);
}
