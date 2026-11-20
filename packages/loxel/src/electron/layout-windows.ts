/**
 * The windows whose layout session rows main answers for (see docs/STATE_AND_STORAGE.md, Layout
 * persistence): which are still open, for the server to keep their rows, and in what order closed
 * windows' layouts are promoted. Outside a quit a closing window is promoted on its own. A quit
 * closes every window at once, so those are held until the last one closes and promoted together,
 * least recently used first, which the server applies in order: the window used last wins every
 * worktree it has a row for. Focus stops counting once a quit has closed a window, since macOS
 * makes a remaining window key as each one closes.
 */
export class LayoutWindows {
  /** Bumped on every open and focus: a window's value is when it was last used. */
  private clock = 0;
  private readonly open = new Map<string, number>();
  private readonly closedInQuit = new Map<string, number>();
  /** A quit has closed a window: the focus that follows is AppKit's, not the user's. */
  private quitClosing = false;

  opened(windowId: string): void {
    this.open.set(windowId, ++this.clock);
  }

  focused(windowId: string): void {
    if (this.quitClosing || !this.open.has(windowId)) return;
    this.open.set(windowId, ++this.clock);
  }

  /**
   * The window closed: the windows to promote now, in order. During a quit (`quitting`) that is
   * none until the last open window closes, then every window the quit closed. Outside one, the
   * window itself, after any a quit that did not happen still holds, which are older.
   */
  closed(windowId: string, quitting: boolean): string[] {
    const lastUsed = this.open.get(windowId) ?? 0;
    this.open.delete(windowId);
    if (!quitting) return [...this.takeHeld(), windowId];
    this.quitClosing = true;
    this.closedInQuit.set(windowId, lastUsed);
    return this.open.size === 0 ? this.takeHeld() : [];
  }

  /**
   * The windows a quit closed and still holds, least recently used first, to promote in one
   * request. Taking them ends the quit's hold on focus: a window opening means the quit is over.
   */
  takeHeld(): string[] {
    const ordered = [...this.closedInQuit].sort(([, a], [, b]) => a - b).map(([id]) => id);
    this.closedInQuit.clear();
    this.quitClosing = false;
    return ordered;
  }

  /** Every window not yet closed, a reloading one included: their session rows are alive. */
  openWindowIds(): string[] {
    return [...this.open.keys()];
  }
}
