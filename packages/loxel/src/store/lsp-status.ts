import { create } from "zustand";

import type { LspStopReason } from "@/lib/lsp-connection";

/** A language server whose client stopped reconnecting, for the status bar. */
export interface StoppedLanguageServer {
  name: string;
  reason: LspStopReason;
  /** The server's close reason, when it gave one. */
  detail: string;
}

interface LspStatusState {
  /** Keyed by the client's route (`ws/python-lsp`); one client per route at a time. */
  stopped: ReadonlyMap<string, StoppedLanguageServer>;
  setStopped: (route: string, entry: StoppedLanguageServer | null) => void;
}

export const useLspStatusStore = create<LspStatusState>()((set) => ({
  stopped: new Map(),
  setStopped: (route, entry) =>
    set((s) => {
      if (!entry && !s.stopped.has(route)) return s;
      const stopped = new Map(s.stopped);
      if (entry) stopped.set(route, entry);
      else stopped.delete(route);
      return { stopped };
    }),
}));
