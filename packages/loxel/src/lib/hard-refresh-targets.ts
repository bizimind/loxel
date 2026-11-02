/**
 * Registry of browser panels' hard refresh, keyed by the panel's root element.
 *
 * The `browser.hardRefresh` action applies to the browser panel that holds keyboard focus (its page
 * or its toolbar), whichever tab is active, and is disabled everywhere else.
 */

import { createFocusTargetRegistry } from "./focus-target-registry";

const hardRefreshTargets = createFocusTargetRegistry<() => void>();

export const registerHardRefreshTarget = hardRefreshTargets.register;
export const getFocusedHardRefreshTarget = hardRefreshTargets.getFocused;
