import type { PanelOpenOptions } from "./api/panel-placement-model";

/**
 * How long an open request waits for a Loxel window to connect — long enough for a cold start,
 * where the app, its server and the first window's renderer all start up.
 */
const WINDOW_WAIT_MS = 30_000;
const RETRY_INTERVAL_MS = 300;

/** A terminal to open: where its shell starts, what to type into it, and the tab title. */
export interface OpenTerminalRequest {
  /** Absolute directory the shell starts in. */
  cwd: string;
  /** Shell command line typed into the shell once it is running. */
  command?: string;
  title?: string;
}

/**
 * Body of `POST /api/open`: a file or folder or a new terminal for the window in use (`windowId`'s,
 * else the focused one), or a URL for the windows showing a worktree (`windowId`'s gets the
 * placement). A folder, revealed in the file tree, ignores `placement` and needs focus.
 */
export type OpenRequest = (
  | { filePath: string }
  | { url: string; wtPath: string }
  | { terminal: OpenTerminalRequest }
) & { windowId?: string } & PanelOpenOptions;

/** Reply to `POST /api/open`: `warning` notes part of the request that was ignored. */
export interface OpenResult {
  warning?: string;
}

interface RequestOpenOptions {
  /** Called once when no window has connected yet and the request starts waiting for one. */
  onWaiting?: () => void;
  windowWaitMs?: number;
}

/**
 * Ask the Loxel server at `serverUrl` to open a file, folder, URL or terminal. Files, folders and
 * terminals are sent to a window, so a 503 means none has connected yet — Loxel is still
 * launching — and the request is retried for a while instead of failing.
 */
export async function requestOpen(
  serverUrl: string,
  request: OpenRequest,
  { onWaiting, windowWaitMs = WINDOW_WAIT_MS }: RequestOpenOptions = {},
): Promise<OpenResult> {
  const post = () =>
    fetch(`${serverUrl}/api/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

  let res = await post();
  if (res.status === 503) {
    onWaiting?.();
    const start = Date.now();
    while (res.status === 503 && Date.now() - start < windowWaitMs) {
      await new Promise((resolve) => {
        setTimeout(resolve, RETRY_INTERVAL_MS);
      });
      res = await post();
    }
  }
  const data: unknown = await res.json().catch(() => null);
  if (res.ok) {
    const warning =
      typeof data === "object" && data !== null && "warning" in data ? data.warning : undefined;
    return typeof warning === "string" ? { warning } : {};
  }

  const message =
    typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
      ? data.error
      : `Server returned ${res.status}`;
  throw new Error(message);
}
