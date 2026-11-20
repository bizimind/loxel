/**
 * The windows whose layout session rows main answers for (see docs/STATE_AND_STORAGE.md, Layout
 * persistence): which are still open, for the server to keep their rows, and in what order closed
 * windows' layouts are promoted. Outside a quit a closing window is promoted on its own. A quit
 * closes every window at once, so those wait for one promote, least recently focused first, which
 * the server applies in order: the window used last wins every worktree it has a row for.
 */
export class LayoutWindows {
  /** Bumped on every open and focus: a window's value is when it was last used. */
  private clock = 0;
  private readonly open = new Map<string, number>();
  private readonly closedInQuit = new Map<string, number>();

  opened(windowId: string): void {
    this.open.set(windowId, ++this.clock);
  }

  focused(windowId: string): void {
    if (this.open.has(windowId)) this.open.set(windowId, ++this.clock);
  }

  /**
   * The window closed: the windows to promote now, which is none during a quit (`quitting`), whose
   * windows wait for {@link takeQuitPromotes}.
   */
  closed(windowId: string, quitting: boolean): string[] {
    const lastUsed = this.open.get(windowId);
    this.open.delete(windowId);
    if (!quitting) return [windowId];
    this.closedInQuit.set(windowId, lastUsed ?? 0);
    return [];
  }

  /** The windows a quit closed, least recently used first, to promote in one request. */
  takeQuitPromotes(): string[] {
    const ordered = [...this.closedInQuit].sort(([, a], [, b]) => a - b).map(([id]) => id);
    this.closedInQuit.clear();
    return ordered;
  }

  /** Every window not yet closed, a reloading one included: their session rows are alive. */
  openWindowIds(): string[] {
    return [...this.open.keys()];
  }
}
