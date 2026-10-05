/**
 * Registry of find-in-panel handlers, keyed by the panel's root element.
 *
 * The `find.*` actions (⌘F, ⌘G, ⇧⌘G) apply to whichever registered panel holds keyboard focus,
 * and are disabled everywhere else so the key reaches the focused widget (e.g. Monaco's own find).
 */

export interface FindHandlers {
  /** Show the find bar and focus its input. */
  open: () => void;
  next: () => void;
  previous: () => void;
}

const targets = new Map<Element, FindHandlers>();

/** Register `handlers` for focus anywhere inside `root`. Returns an unregister function. */
export function registerFindTarget(root: Element, handlers: FindHandlers): () => void {
  targets.set(root, handlers);
  return () => {
    if (targets.get(root) === handlers) targets.delete(root);
  };
}

/** Handlers of the registered panel that contains the focused element, if any. */
export function getFocusedFindTarget(): FindHandlers | undefined {
  for (let el = document.activeElement; el; el = el.parentElement) {
    const handlers = targets.get(el);
    if (handlers) return handlers;
  }
  return undefined;
}
