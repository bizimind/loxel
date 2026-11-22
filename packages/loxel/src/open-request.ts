import type { AgentOrigin } from "./api/agent-terminal-model";
import type { PanelOpenOptions } from "./api/panel-placement-model";

/**
 * How long an open request waits for a Loxel window to connect — long enough for a cold start,
 * where the app, its server and the first window's renderer all start up.
 */
export const WINDOW_WAIT_MS = 30_000;
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
 * placement), else for the window in use. A URL without `wtPath` (a link macOS hands to Loxel as
 * the browser) is for the window in use, which opens it in its worktree, or in Home. A folder,
 * revealed in the file tree, ignores `placement` and `pinWtPath`, and needs focus.
 *
 * `pinWtPath` is the worktree to open in, overriding the one a file or terminal belongs to.
 * `commandWtPath` does the same for a file sent with a URL for that worktree, but is dropped if it
 * names no project's worktree, since the file can still open by itself.
 *
 * `agent` marks a terminal a coding agent asked for: it follows "When an Agent Starts a Terminal".
 *
 * `incognito` opens a URL in an incognito tab, in the window in use only; it never waits for a
 * window in the server's inbox.
 */
export type OpenRequest = (
  | { filePath: string; pinWtPath?: string; commandWtPath?: string }
  | { url: string; wtPath?: string; incognito?: true }
  | { terminal: OpenTerminalRequest; pinWtPath?: string; agent?: AgentOrigin }
) & { windowId?: string } & PanelOpenOptions;

/**
 * Reply to `POST /api/open`: `warning` notes part of the request that was ignored, `queued` that no
 * window was connected, so the open waits in the server's inbox for the next one, and `asked` that
 * an agent's terminal waits for the user to answer in Loxel (in the next window, when also
 * `queued`).
 */
export interface OpenResult {
  warning?: string;
  queued?: boolean;
  asked?: boolean;
}

interface RequestOpenOptions {
  /** Called once when no window has connected yet and the request starts waiting for one. */
  onWaiting?: () => void;
  windowWaitMs?: number;
  /**
   * How long to wait for a window before letting the server queue the request for the next one
   * (`queue`), instead of retrying until `windowWaitMs` and failing: 0 when no window is coming
   * (Loxel was not launched), the wait itself when one should (it was). Undefined never queues.
   */
  queueAfterMs?: number;
  /**
   * The Unix socket to send the request over (the `loxel` CLI's); `serverUrl` then only fills the
   * URL.
   */
  unix?: string;
  /** Headers to send with each request: Electron main's `Authorization` over TCP. */
  headers?: Record<string, string>;
}

/**
 * Ask the Loxel server at `serverUrl`, or on the `unix` socket, to open a file, folder, URL or
 * terminal. Files, folders and terminals are sent to a window, so a 503 means none has connected
 * yet — Loxel is still launching — and the request is retried for a while instead of failing, or,
 * after `queueAfterMs`, left in the server's inbox for the next window. So is a request no server
 * answers, as between a server that is exiting (quit, update restart, crash) and its replacement.
 */
export async function requestOpen(
  serverUrl: string,
  request: OpenRequest,
  {
    onWaiting,
    windowWaitMs = WINDOW_WAIT_MS,
    queueAfterMs,
    unix,
    headers,
  }: RequestOpenOptions = {},
): Promise<OpenResult> {
  const start = Date.now();
  let unreachable: unknown = null;
  /** The response, or null when no server answered: one may be handing over to the next. */
  const post = async (queue: boolean): Promise<Response | null> => {
    try {
      return await fetch(`${serverUrl}/api/open`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(queue ? { ...request, queue } : request),
        ...(unix ? { unix } : {}),
      });
    } catch (err) {
      unreachable = err;
      return null;
    }
  };
  const mayQueue = () => queueAfterMs !== undefined && Date.now() - start >= queueAfterMs;

  let res = await post(mayQueue());
  if (res === null || res.status === 503) {
    onWaiting?.();
    while ((res === null || res.status === 503) && Date.now() - start < windowWaitMs) {
      await new Promise((resolve) => {
        setTimeout(resolve, RETRY_INTERVAL_MS);
      });
      res = await post(mayQueue());
    }
  }
  // The wait ended with no window: the next one gets the request.
  if (res?.status === 503 && queueAfterMs !== undefined) res = await post(true);
  if (res === null) {
    throw new Error(`Cannot reach Loxel at ${unix ?? serverUrl}`, { cause: unreachable });
  }
  const data: unknown = await res.json().catch(() => null);
  if (res.ok) {
    const fields = typeof data === "object" && data !== null ? data : {};
    const warning = "warning" in fields ? fields.warning : undefined;
    const queued = "queued" in fields && fields.queued === true;
    const asked = "asked" in fields && fields.asked === true;
    return {
      ...(typeof warning === "string" ? { warning } : {}),
      ...(queued ? { queued } : {}),
      ...(asked ? { asked } : {}),
    };
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
  /** How many went to the server's inbox, to open when a window connects. */
  queued: number;
  /** How many wait for the user to answer in Loxel (some of them also `queued`). */
  asked: number;
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
  {
    onWaiting,
    windowWaitMs = WINDOW_WAIT_MS,
    queueAfterMs,
    unix,
    headers,
  }: RequestOpenOptions = {},
): Promise<OpenAllResult> {
  const start = Date.now();
  const remaining = (ms: number) => Math.max(0, start + ms - Date.now());
  let announced = false;
  const warnings = new Set<string>();
  let queued = 0;
  let asked = 0;
  const failures: OpenAllResult["failures"] = [];
  for (const [index, request] of requests.entries()) {
    try {
      const result = await requestOpen(serverUrl, request, {
        unix,
        headers,
        windowWaitMs: remaining(windowWaitMs),
        ...(queueAfterMs === undefined ? {} : { queueAfterMs: remaining(queueAfterMs) }),
        onWaiting: () => {
          if (!announced) onWaiting?.();
          announced = true;
        },
      });
      if (result.warning) warnings.add(result.warning);
      if (result.queued) queued += 1;
      if (result.asked) asked += 1;
    } catch (err) {
      failures.push({ index, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { warnings: [...warnings], queued, asked, failures };
}
