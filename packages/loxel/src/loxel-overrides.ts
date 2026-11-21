/**
 * The environment variables that point a Loxel elsewhere than where it runs by default: its mode
 * (dev, demo), its state, port and renderer, its key file, and a dev app's renderer URL. Contributors
 * and the dev, demo and test scripts set them on purpose. Nothing else should take them: a packaged
 * app ignores them (src/electron/env.ts), and the server's terminals do not inherit them
 * (terminal-manager.ts), so a server, app or tool started in one runs as if started anywhere else.
 */
export const LOXEL_OVERRIDE_ENV_VARS = [
  "LOXEL_DEV",
  "LOXEL_DEMO",
  "LOXEL_DEMO_INSTANCE",
  "LOXEL_DEMO_HIDDEN",
  "LOXEL_STATE_DIR",
  "LOXEL_SERVE_PORT",
  "LOXEL_STATIC_DIR",
  "LOXEL_DEK_FILE",
  "VITE_DEV_SERVER_URL",
] as const;

/** A copy of `env` without {@link LOXEL_OVERRIDE_ENV_VARS}. */
export function withoutLoxelOverrides<T extends Record<string, string | undefined>>(env: T): T {
  const kept = { ...env };
  for (const name of LOXEL_OVERRIDE_ENV_VARS) delete kept[name];
  return kept;
}
