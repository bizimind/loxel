/**
 * How the app leaves: what its server does to the terminals, and whether the app opens again.
 * Kept free of Electron so the decisions are testable; main.ts wires them to the menu, the IPC and
 * `before-quit` / `will-quit`.
 */
import type { WhenQuitting } from "../lib/quit-terminals";
import type { ShutdownTerminals } from "../parent-channel-protocol";

export interface QuitPlan {
  terminals: ShutdownTerminals;
  /** Open the app again once it has quit (Restart Loxel). */
  relaunch: boolean;
}

/** Quit and End Terminals, and the quits the app starts itself (a startup error): terminals end. */
export const QUIT: QuitPlan = { terminals: "end", relaunch: false };
/** Quit and Keep Terminals: the shells keep running until Loxel is back. */
export const QUIT_KEEPING_TERMINALS: QuitPlan = { terminals: "keep", relaunch: false };
/** Restart Loxel: quit keeping the terminals, and open again. */
export const RESTART: QuitPlan = { terminals: "keep", relaunch: true };

/** Ask the user before quitting, then quit with the plan they choose. */
export const ASK = "ask";

/**
 * What a quit that names no plan does: Quit Loxel (⌘Q), the Dock's Quit, logout. It follows the
 * "When quitting Loxel" setting. `canAsk` is false where no one can be asked (logout and shutdown,
 * which must not be held up; an update install, which decides the terminals itself; a hidden demo,
 * which its driver quits): asking then ends the terminals, as Quit always did.
 */
export function unplannedQuit(setting: WhenQuitting, canAsk: boolean): QuitPlan | typeof ASK {
  if (setting === "ask") return canAsk ? ASK : QUIT;
  return setting === "keep" ? QUIT_KEEPING_TERMINALS : QUIT;
}

/**
 * The plan of the quit under way. A plan is requested just before the `app.quit()` it is for, and
 * the `before-quit` that call fires takes it. A quit that was cancelled (a window refused to close)
 * so leaves nothing behind: the next one, which macOS may start from the Dock or at logout, follows
 * the setting unless it is requested too. Electron fires no second `before-quit` for an
 * `app.quit()` while a quit is under way, so `will-quit` takes a plan requested since then.
 */
export class QuitPlans {
  private requested: QuitPlan | null = null;
  private plan: QuitPlan = QUIT;

  /** The plan for the `app.quit()` about to be called. */
  request(plan: QuitPlan): void {
    this.requested = plan;
  }

  /**
   * `before-quit`: the quit starting now follows the plan requested for it, or else `unplanned`.
   * {@link ASK} means the quit is to be cancelled while the user is asked; the plan they choose is
   * then requested for a new quit.
   */
  begin(unplanned: QuitPlan | typeof ASK): QuitPlan | typeof ASK {
    const plan = this.requested ?? unplanned;
    this.requested = null;
    // A quit cancelled to ask leaves no plan of its own behind.
    this.plan = plan === ASK ? QUIT : plan;
    return plan;
  }

  /** `will-quit`: the plan of the quit under way, the latest requested for it. */
  current(): QuitPlan {
    if (this.requested) this.begin(this.plan);
    return this.plan;
  }
}

/**
 * What `will-quit` carries out. An update install is its own plan, whatever started the quit:
 * Squirrel opens the new app itself, and `installTerminals` (null when no update is installing)
 * says what the install does to the terminals.
 */
export function planAtWillQuit(
  plan: QuitPlan,
  installTerminals: ShutdownTerminals | null,
): QuitPlan {
  if (installTerminals === null) return plan;
  return { terminals: installTerminals, relaunch: false };
}
