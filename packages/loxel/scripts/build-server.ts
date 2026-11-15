/**
 * Build the server and the terminal host, with the host build ID embedded in both:
 *
 *   bun scripts/build-server.ts compile   # build/loxel-server and build/loxel-terminal-host
 *   bun scripts/build-server.ts bundle    # dist/server/, run with `bun dist/server/index.js`
 *
 * The ID is computed from the host's code before either is built (host-build-id.ts), so a server
 * always knows which running hosts are its own generation. See docs/TERMINAL_HOST.md#generations.
 */
import path from "node:path";

import { $ } from "bun";

import { computeHostBuildId } from "../src/terminal-host/host-build-id";
import { TERMINAL_HOST_BINARY } from "../src/terminal-host/host-files";
import { TERMINAL_HOST_BUNDLE } from "../src/terminal-host/host-launcher";

const packageRoot = path.resolve(import.meta.dirname, "..");
const SERVER_ENTRIES = ["src/server/index.ts", "src/server/git-exec-worker.ts"];
const HOST_ENTRY = "src/terminal-host/main.ts";

const mode = Bun.argv[2];
if (mode !== "compile" && mode !== "bundle") {
  throw new Error("Usage: build-server.ts compile|bundle");
}

const hostBuildId = await computeHostBuildId(path.join(packageRoot, HOST_ENTRY));
const define = `LOXEL_TERMINAL_HOST_BUILD_ID=${JSON.stringify(hostBuildId)}`;
console.log(`[build-server] terminal host build ${hostBuildId}`);

if (mode === "compile") {
  await $`bun build ${SERVER_ENTRIES} --compile --define ${define} --outfile build/loxel-server`.cwd(
    packageRoot,
  );
  await $`bun build ${HOST_ENTRY} --compile --define ${define} --outfile ${`build/${TERMINAL_HOST_BINARY}`}`.cwd(
    packageRoot,
  );
} else {
  await $`bun build ${SERVER_ENTRIES} --outdir dist/server --target bun --define ${define}`.cwd(
    packageRoot,
  );
  await $`bun build ${HOST_ENTRY} --outfile ${`dist/server/${TERMINAL_HOST_BUNDLE}`} --target bun --define ${define}`.cwd(
    packageRoot,
  );
}
