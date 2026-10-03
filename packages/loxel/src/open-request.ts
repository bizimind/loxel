/**
 * How long an open request waits for a Loxel window to connect — long enough for a cold start,
 * where the app, its server and the first window's renderer all start up.
 */
const WINDOW_WAIT_MS = 30_000;
const RETRY_INTERVAL_MS = 300;

/**
 * Body of `POST /api/open`: a file or folder (optionally for a specific window), or a URL for the
 * windows showing a worktree.
 */
export type OpenRequest = { filePath: string; windowId?: string } | { url: string; wtPath: string };

interface RequestOpenOptions {
  /** Called once when no window has connected yet and the request starts waiting for one. */
  onWaiting?: () => void;
  windowWaitMs?: number;
}

/**
 * Ask the Loxel server at `serverUrl` to open a file, folder or URL. Files and folders are sent to
 * a window, so a 503 means none has connected yet — Loxel is still launching — and the request is
 * retried for a while instead of failing.
 */
export async function requestOpen(
  serverUrl: string,
  request: OpenRequest,
  { onWaiting, windowWaitMs = WINDOW_WAIT_MS }: RequestOpenOptions = {},
): Promise<void> {
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
  if (res.ok) return;

  const data: unknown = await res.json().catch(() => null);
  const message =
    typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
      ? data.error
      : `Server returned ${res.status}`;
  throw new Error(message);
}
