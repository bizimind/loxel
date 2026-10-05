/**
 * Registry of per-panel focus handlers, keyed by dockview panel id.
 *
 * Keyboard focus navigation re-focuses a panel that is already active (e.g. returning to the
 * center from a side tool bar), which fires no dockview activation event, so panels expose their
 * "focus my widget" function here.
 */

/** Focuses the panel's widget; returns false when it had nothing to focus (e.g. still loading). */
type PanelFocusHandler = () => boolean;

const handlers = new Map<string, PanelFocusHandler>();

/** Register `focus` for `panelId`. Returns an unregister function. */
export function registerPanelFocus(panelId: string, focus: PanelFocusHandler): () => void {
  handlers.set(panelId, focus);
  return () => {
    if (handlers.get(panelId) === focus) handlers.delete(panelId);
  };
}

/** Run the panel's registered focus handler. Returns false when there is none or it failed. */
export function focusRegisteredPanel(panelId: string): boolean {
  return handlers.get(panelId)?.() ?? false;
}
