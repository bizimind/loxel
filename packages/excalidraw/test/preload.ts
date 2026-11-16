/**
 * Test preload: put the native binary canvas-loader.ts imports in place before
 * any test loads it (see native-binary.ts). It stays, gitignored, for later runs.
 */
import { ensureNativeBinary } from "../native-binary.ts";

await ensureNativeBinary();
