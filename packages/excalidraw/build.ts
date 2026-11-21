/**
 * Compile the excalidraw CLI into a standalone binary at dist/excalidraw.
 *
 * canvas-loader.ts embeds the native skia binary via a { type: "file" } import,
 * which must exist to compile (see native-binary.ts); a copy made for the
 * build is removed afterwards.
 */
import { resolve } from "node:path";

import { ensureNativeBinary, removeNativeBinary } from "./native-binary.ts";

const root = import.meta.dirname;
const copiedBinary = await ensureNativeBinary();
const outBinary = resolve(root, "dist/excalidraw");

try {
  await Bun.$`mkdir -p ${resolve(root, "dist")}`;
  // canvas-loader.ts loads @napi-rs/canvas/js-binding only when run from
  // source; left in, the compiled binary would embed a second ~30 MB copy of
  // the native binary through it.
  await Bun.$`bun build ${resolve(root, "src/cli.ts")} --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv --minify --external @napi-rs/canvas/js-binding --outfile ${outBinary}`.quiet();
} finally {
  if (copiedBinary) removeNativeBinary();
}

console.log(`Built ${outBinary}`);
