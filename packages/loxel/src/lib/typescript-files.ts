/** Extensions of the TS/JS source files TypeScript compiles and checks. */
export const TS_SOURCE_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"] as const;

const TS_SOURCE_PATH = new RegExp(`\\.(?:${TS_SOURCE_EXTENSIONS.join("|")})$`, "i");
// `tsc` reports config errors (e.g. TS5023 unknown option) against the tsconfig file itself.
const TSCONFIG_PATH = /(?:^|\/)tsconfig[^/]*\.json$/i;

/** Whether the project-wide `tsc` diagnostics snapshot can hold markers for `filePath`. */
export function hasTypeScriptDiagnostics(filePath: string): boolean {
  return TS_SOURCE_PATH.test(filePath) || TSCONFIG_PATH.test(filePath);
}
