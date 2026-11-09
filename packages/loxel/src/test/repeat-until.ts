/** Longer than the debounce of the watches this is used with, which each change restarts. */
const REPEAT_MS = 1500;
const STILL_WAITING = Symbol("still waiting");

/**
 * Does `act` until `heard` settles, and returns what it settled with. For a file watch, which can
 * miss a change made while it is being armed, and gives no sign of when it is.
 */
export async function repeatUntil<T>(heard: Promise<T>, act: () => Promise<unknown>): Promise<T> {
  for (;;) {
    await act();
    const pause = Bun.sleep(REPEAT_MS).then(() => STILL_WAITING);
    const result = await Promise.race([heard, pause]);
    if (result !== STILL_WAITING) return result as T;
  }
}
