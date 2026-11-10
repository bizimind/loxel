/**
 * Ports of the web dev setup (`pnpm run dev`): the Bun server and the Vite dev server that proxies
 * to it. `LOXEL_SERVE_PORT` and `LOXEL_VITE_PORT` move both, so a second worktree can run its own
 * dev instance beside one already on the defaults. One source of truth for vite.config.ts and the
 * server's dev-origin check (src/server/request-origin.ts).
 */

const DEFAULT_VITE_PORT = 5173;
/** The dev server's port when `LOXEL_SERVE_PORT` is unset; production uses 7433. */
export const DEFAULT_DEV_SERVER_PORT = 7434;

/**
 * A TCP port from environment variable `name`, or undefined when unset. Anything else throws:
 * falling back to a default would put two instances on one port.
 */
export function parsePortEnv(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a TCP port (1-65535), not "${value}"`);
  }
  return port;
}

/** The Vite dev server's port: `LOXEL_VITE_PORT`, default 5173. */
export const vitePort = (env: Record<string, string | undefined>): number =>
  parsePortEnv("LOXEL_VITE_PORT", env.LOXEL_VITE_PORT) ?? DEFAULT_VITE_PORT;
