/**
 * Timeouts and lag readings that a laptop's sleep does not trip. On wake, an event loop runs its
 * due timers before it reads the socket data that arrived meanwhile, so a plain timer would fail a
 * request whose answer is already buffered, and a lag probe would take the night for a stall. See
 * docs/TERMINAL_HOST.md#unresponsive-hosts for its use with the terminal hosts.
 *
 * Sleep shows as wall-clock time that passed without monotonic time (`performance.now()` stops
 * while the machine sleeps). A timer that fires far later than it was due shows a process whose
 * event loop did not run (suspended, or blocked): either way, what it timed got no chance.
 */

/** Wall-clock time past monotonic time beyond which the machine is taken to have slept. */
export const SLEEP_GAP_MS = 1000;
/** How late a timer may fire before its window counts as one its event loop did not run in. */
const LATE_TIMER_MS = 2000;

export interface Clocks {
  /** Wall-clock milliseconds, which go on while the machine sleeps. */
  wall: () => number;
  /** Monotonic milliseconds, which stop while it sleeps. */
  awake: () => number;
}

export const SYSTEM_CLOCKS: Clocks = { wall: () => Date.now(), awake: () => performance.now() };

/** A reading of both clocks. */
export interface ClockReading {
  wall: number;
  awake: number;
}

export function readClocks(clocks: Clocks): ClockReading {
  return { wall: clocks.wall(), awake: clocks.awake() };
}

/** How long the machine slept between two readings, as far as the clocks tell. */
export function sleptBetween(start: ClockReading, end: ClockReading): number {
  return Math.max(0, end.wall - start.wall - (end.awake - start.awake));
}

/**
 * Call `onExpire` once `ms` have passed with the machine awake and this process running. A window
 * the machine slept in starts over, however often. One whose timer fired more than
 * {@link LATE_TIMER_MS} late with no sleep in it (this process stopped, or its event loop blocked)
 * starts over once: an event loop blocked again and again must not keep the timeout from ever
 * expiring. The expiry waits for the I/O already pending, so an answer read on wake comes first
 * and can cancel it. Returns the cancel function.
 */
export function awakeTimeout(
  ms: number,
  onExpire: () => void,
  clocks: Clocks = SYSTEM_CLOCKS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let check: ReturnType<typeof setImmediate> | null = null;
  let restartedLate = false;
  const arm = () => {
    const start = readClocks(clocks);
    timer = setTimeout(() => {
      timer = null;
      const end = readClocks(clocks);
      if (sleptBetween(start, end) > SLEEP_GAP_MS) {
        arm();
        return;
      }
      const late = Math.max(end.wall - start.wall, end.awake - start.awake) - ms;
      if (late > LATE_TIMER_MS && !restartedLate) {
        restartedLate = true;
        arm();
        return;
      }
      check = setImmediate(() => {
        check = null;
        onExpire();
      });
    }, ms);
  };
  arm();
  return () => {
    if (timer) clearTimeout(timer);
    if (check) clearImmediate(check);
    timer = null;
    check = null;
  };
}
