/**
 * Demo mode's instances (`LOXEL_DEMO_INSTANCE`), so several demo apps run side by side: each gets
 * its own server port and state directory. One source of truth for the Electron main process, the
 * server and the demo scripts; see docs/ELECTRON.md#demo-mode.
 */

/** Instance 0's server port; instance n runs on this plus n. */
const DEMO_BASE_PORT = 7435;

/**
 * `LOXEL_DEMO_INSTANCE` as a non-negative integer, 0 when unset. Anything else throws: falling back
 * to 0 would put two demos on one port and state directory.
 */
export function parseDemoInstance(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  if (!/^\d+$/.test(value)) {
    throw new Error(`LOXEL_DEMO_INSTANCE must be a non-negative integer, not "${value}"`);
  }
  return Number(value);
}

/** The server port of demo instance `instance`. */
export const demoPort = (instance: number): number => DEMO_BASE_PORT + instance;

/** The state directory name of demo instance `instance`, under `~/.local/state/loxel`. */
export const demoStateName = (instance: number): string =>
  instance ? `loxel-demo-${instance}` : "loxel-demo";
