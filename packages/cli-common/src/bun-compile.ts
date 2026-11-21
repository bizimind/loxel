#!/usr/bin/env bun
/**
 * The one place the repo's standalone binaries get their `bun build --compile` flags.
 *
 * A compiled binary reads `bunfig.toml` and `.env` from its working directory by default, so it
 * would pick up the settings and preload scripts of whatever repo it is run in. These flags turn
 * that off, and keep `tsconfig.json` and `package.json` reads off should Bun's defaults for those
 * change; everything a binary needs is built into it.
 *
 * Build scripts spread `BUN_COMPILE_FLAGS` into their `bun build` call; package.json scripts run
 * the `bun-compile` bin, which takes the rest of `bun build`'s arguments:
 *
 *   bun-compile --minify src/cli.ts --outfile dist/tool
 *
 * `scripts/check-bun-compile.ts` (run by the root `lint`) rejects a compile anywhere else.
 */
export const BUN_COMPILE_FLAGS = [
  "--compile",
  "--no-compile-autoload-bunfig",
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-tsconfig",
  "--no-compile-autoload-package-json",
] as const;

if (import.meta.main) {
  const build = Bun.spawn([process.execPath, "build", ...BUN_COMPILE_FLAGS, ...Bun.argv.slice(2)], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await build.exited);
}
