import type { DockviewPanelApi } from "dockview-react";

import { useEffect } from "react";

/**
 * Delegate panel activation to an underlying widget.
 *
 * "Activated" here means: this panel is the active tab in its group AND the
 * group is the active group of its dockview. We can't rely on
 * `onDidFocusChange` because `api.setActive()` (invoked from our keyboard
 * navigation) does NOT move native DOM focus — it only toggles
 * `dv-active-group` and fires the active-change events. So we listen to both
 * `onDidActiveChange` (panel-within-group) and `onDidActiveGroupChange`
 * (group-within-dockview) and fire the widget focus whenever both flip true.
 *
 * Safe from feedback loops: calling `widget.focus()` inside the handler sets
 * native DOM focus on a descendant, which doesn't re-fire active-change events
 * (those are driven by dockview's explicit setActive calls, not DOM focus).
 *
 * @param api    The dockview panel API from `IDockviewPanelProps`.
 * @param focus  Called when the panel becomes the active-and-focused panel.
 *               Use a stable reference (e.g. `useCallback`) — the hook
 *               resubscribes when it changes.
 */
export function usePanelActivationFocus(api: DockviewPanelApi, focus: () => void): void {
  useEffect(() => {
    const tryFocus = () => {
      if (!api.isActive || !api.isGroupActive) return;
      requestAnimationFrame(() => {
        if (api.isGroupActive) focus();
      });
    };
    const a = api.onDidActiveChange(tryFocus);
    const g = api.onDidActiveGroupChange(tryFocus);
    // After a moveTo(), dockview's panel-level isActive can be stale: the
    // move fires _onDidActiveChange({isActive:false}) before the destination
    // group is activated, and the subsequent group activation is suppressed
    // by the dedup logic in setupGroupEventListeners. Schedule a delayed
    // focus so the move transaction settles before we check isGroupActive.
    const m = api.onDidGroupChange(() => {
      requestAnimationFrame(() => {
        if (api.isGroupActive) {
          requestAnimationFrame(focus);
        }
      });
    });
    // Fire once on mount in case the panel is already the active-and-focused
    // one (e.g. on initial layout restore).
    tryFocus();
    return () => {
      a.dispose();
      g.dispose();
      m.dispose();
    };
  }, [api, focus]);
}
