/** What `getBrowserPageUsage` answers (see `browser-page-lifecycle.ts`). */

/** One page's share of its renderer process. */
export interface BrowserPageUsage {
  webContentsId: number;
  /** Resident memory, in KB. Pages sharing a process split it evenly. */
  memoryKB: number;
  /** CPU use, in percent of one core, since the previous measurement (0 on the first). */
  cpuPercent: number;
  /** It plays sound or has DevTools open, so it must keep running. */
  inUse: boolean;
}

export interface BrowserPagesUsage {
  /** The machine's physical memory, in KB. */
  totalMemoryKB: number;
  pages: BrowserPageUsage[];
}
