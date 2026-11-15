import type { RegisteredToolchain } from "@/api/toolchain-status-model";

/**
 * One language's toolchain on the server, behind its status bar item: state watched per worktree,
 * the choice stored per worktree, and the routes that report it, list candidates and change it.
 * Modules are listed in `toolchain-statuses.ts`. See docs/LANGUAGE_SERVERS.md.
 */
export interface ToolchainStatusModule {
  toolchain: RegisteredToolchain;
  /** Keeps a worktree's toolchain resolved and watched until the returned function is called. */
  subscribe: (wtPath: string, listener: (update: { changed: boolean }) => void) => () => void;
  /** Resolves one worktree's toolchain again. */
  refresh: (wtPath: string) => void;
  /** Resolves every toolchain again when a login-shell capture changed a variable it reads. */
  refreshAll: (changedNames: Iterable<string>) => void;
  /** Calls `listener` with the worktree path whenever a worktree's choice is set or cleared. */
  onOverrideChange: (listener: (wtPath: string) => void) => () => void;
  /** Store-database key of a worktree's choice, deleted with the worktree. */
  overrideStoreKey: (wtPath: string) => string;
  /** Route paths with handlers. The shared code has validated the worktree each one is given. */
  routes: {
    GET: Record<string, (wtPath: string) => Promise<Response>>;
    POST: Record<string, (wtPath: string, body: Record<string, unknown>) => Promise<Response>>;
  };
}
