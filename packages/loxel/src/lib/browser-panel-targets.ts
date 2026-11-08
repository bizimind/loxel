/**
 * Registry of browser panels' keyboard actions, keyed by the panel's root element.
 *
 * The `browser.*` actions apply to the browser panel that holds keyboard focus (its page or its
 * toolbar), whichever tab is active, and are disabled everywhere else.
 */

import { createFocusTargetRegistry } from "./focus-target-registry";

export interface BrowserPanelTarget {
  /** Reload the page, bypassing the cache. */
  hardRefresh: () => void;
  /** Bookmark the page, or remove its bookmark. */
  toggleBookmark: () => void;
}

const browserPanelTargets = createFocusTargetRegistry<BrowserPanelTarget>();

export const registerBrowserPanelTarget = browserPanelTargets.register;
export const getFocusedBrowserPanel = browserPanelTargets.getFocused;
