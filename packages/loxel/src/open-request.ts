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
 * placement), else for the window in use. A folder, revealed in the file tree, ignores `placement`
 * and `pinWtPath`, and needs focus.
 *
 * `pinWtPath` is the worktree to open in, overriding the one a file or terminal belongs to.
 * `commandWtPath` does the same for a file sent with a URL for that worktree, but is dropped if it
 * names no project's worktree, since the file can still open by itself.
 */
export type OpenRequest = (
  | { filePath: string; pinWtPath?: string; commandWtPath?: string }
  | { url: string; wtPath: string }
  | { terminal: OpenTerminalRequest; pinWtPath?: string }
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

/** What became of {@link requestOpenAll}'s requests. */
export interface OpenAllResult {
  /** The distinct warnings of the requests that went through. */
  warnings: string[];
  /** The requests that failed, by index, and why. */
  failures: Array<{ index: number; message: string }>;
}

/**
 * Send `requests` in order, each once the last is accepted, so their panels open in that order. One
 * that fails does not stop the rest. They share one wait for a window, so a window that never comes
 * costs that wait once, not once per request.
 */
export async function requestOpenAll(
  serverUrl: string,
  requests: OpenRequest[],
  { onWaiting, windowWaitMs = WINDOW_WAIT_MS }: RequestOpenOptions = {},
): Promise<OpenAllResult> {
  const deadline = Date.now() + windowWaitMs;
  let announced = false;
  const warnings = new Set<string>();
  const failures: OpenAllResult["failures"] = [];
  for (const [index, request] of requests.entries()) {
    try {
      const { warning } = await requestOpen(serverUrl, request, {
        windowWaitMs: Math.max(0, deadline - Date.now()),
        onWaiting: () => {
          if (!announced) onWaiting?.();
          announced = true;
        },
      });
      if (warning) warnings.add(warning);
    } catch (err) {
      failures.push({ index, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { warnings: [...warnings], failures };
}
