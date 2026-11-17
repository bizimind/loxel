import { type ServerId, type WorktreeRef, toServerId, worktreeRef } from "./worktree-ref";

/**
 * The server this window was loaded from, and the one it talks to: main.tsx sets it from
 * `GET /api/version` before the first render, and `WsClient` reloads the page when a hello names
 * another, so it never changes while the page lives.
 */
let localServer: ServerId | null = null;

export function setLocalServerId(id: string): void {
  localServer = toServerId(id);
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
