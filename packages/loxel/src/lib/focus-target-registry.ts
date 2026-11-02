/**
 * Registries of per-panel handlers keyed by the panel's root element, for actions that apply to
 * whichever registered panel holds keyboard focus (and are disabled everywhere else).
 */

const changeListeners = new Set<() => void>();

/**
 * Call `listener` whenever a target is registered or removed in any registry — which can enable or
 * disable an action without focus moving (a panel mounting around an already-focused webview).
 */
export function onFocusTargetsChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function notifyChange(): void {
  for (const listener of changeListeners) listener();
}

export interface FocusTargetRegistry<Handlers> {
  /** Register `handlers` for focus anywhere inside `root`. Returns an unregister function. */
  register: (root: Element, handlers: Handlers) => () => void;
  /** Handlers of the registered panel that contains the focused element, if any. */
  getFocused: () => Handlers | undefined;
}

export function createFocusTargetRegistry<Handlers>(): FocusTargetRegistry<Handlers> {
  const targets = new Map<Element, Handlers>();
  return {
    register: (root, handlers) => {
      targets.set(root, handlers);
      notifyChange();
      return () => {
        if (targets.get(root) !== handlers) return;
        targets.delete(root);
        notifyChange();
      };
    },
    getFocused: () => {
      for (let el = document.activeElement; el; el = el.parentElement) {
        const handlers = targets.get(el);
        if (handlers) return handlers;
      }
      return undefined;
    },
  };
}
