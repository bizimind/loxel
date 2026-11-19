import { connectionOf, type ServerConnection } from "./server-connection";
import { type ServerId, type WorktreeRef, toServerId, worktreeRef } from "./worktree-ref";

/**
 * The server this window was loaded from: main.tsx sets it from `GET /api/version` before the
 * first render (`connectLocalServer`, which also makes its connection), and `WsClient` reloads the
 * page when a hello names another, so it never changes while the page lives.
 */
let localServer: ServerId | null = null;
const localServerKnown = Promise.withResolvers<ServerId>();

export function setLocalServerId(id: string): void {
  localServer = toServerId(id);
  localServerKnown.resolve(localServer);
}

/**
 * Resolves once the window's server is known, for work that can start before the first render,
 * such as a store loading its persisted state.
 */
export function whenLocalServerKnown(): Promise<ServerId> {
  return localServerKnown.promise;
}

export function localServerId(): ServerId {
  if (localServer === null) {
    throw new Error("The window's server is not known yet: the app renders only once it is");
  }
  return localServer;
}

/**
 * The ref of a path on this window's server, for the paths the stores and panels still hold bare.
 * Null and undefined pass through, so an optional worktree (Home) stays one.
 */
export function localRef(path: string): WorktreeRef;
export function localRef(path: string | null): WorktreeRef | null;
export function localRef(path: string | undefined): WorktreeRef | undefined;
export function localRef(path: string | null | undefined): WorktreeRef | null | undefined;
export function localRef(path: string | null | undefined): WorktreeRef | null | undefined {
  return path === null || path === undefined ? path : worktreeRef(localServerId(), path);
}

/**
 * The connection to this window's own server, for what belongs to the window rather than to a
 * worktree: its stored state, its log, its settings. Each caller says why in a comment.
 */
export function localConnection(): ServerConnection {
  return connectionOf(localServerId());
}
