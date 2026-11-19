/** Longer than the debounce of the watches this is used with, which each change restarts. */
const FIRST_PAUSE_MS = 1500;
const STILL_WAITING = Symbol("still waiting");

/**
 * Does `act` until `heard` settles, and returns what it settled with. For a file watch, which can
 * miss a change made while it is being armed, and gives no sign of when it is.
 *
 * Each pause is twice the one before: a repeat restarts the watch's debounce, and the update a
 * slower answer would have brought is superseded. A fixed pause shorter than the debounce plus the
 * answer would never hear one on a loaded machine; a growing one outlasts any.
 */
export async function repeatUntil<T>(heard: Promise<T>, act: () => Promise<unknown>): Promise<T> {
  for (let pauseMs = FIRST_PAUSE_MS; ; pauseMs *= 2) {
    await act();
    const pause = Bun.sleep(pauseMs).then(() => STILL_WAITING);
    const result = await Promise.race([heard, pause]);
    if (result !== STILL_WAITING) return result as T;
  }
}
