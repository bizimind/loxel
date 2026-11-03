/**
 * Builds resources/d3/LICENSE: the notices of d3 and every package its UMD build bundles (d3's
 * whole dependency tree), from their installed LICENSE files, one section per distinct text.
 * The build was made from the versions current when d3 was published; the installed texts carry
 * the same terms with copyright ranges at least as wide.
 *
 * Regenerate after any change to the installed d3 tree: `bun src/d3-notices.ts`.
 * serve.test.ts fails while the committed file differs from what this builds.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const D3_NOTICES_PATH = join(import.meta.dir, "../resources/d3/LICENSE");

interface InstalledPackage {
  name: string;
  version: string;
  dependencies: string[];
}

function readPackage(dir: string): InstalledPackage {
  const parsed: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error(`bad package.json in ${dir}`);
  const { name, version, dependencies } = parsed as Record<string, unknown>;
  if (typeof name !== "string" || typeof version !== "string") {
    throw new Error(`package.json in ${dir} lacks a name or version`);
  }
  const deps = typeof dependencies === "object" && dependencies !== null ? dependencies : {};
  return { name, version, dependencies: Object.keys(deps) };
}

// d3-dsv depends on these only for its command-line tools, which the browser build leaves out.
const NOT_BUNDLED = new Set(["commander", "iconv-lite", "rw"]);

/** d3 and its dependency tree as installed, each package's directory keyed by `name@version`. */
function d3Tree(): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (linkPath: string) => {
    // pnpm links each dependency next to the real directory of the package that depends on it.
    const dir = realpathSync(linkPath);
    const pkg = readPackage(dir);
    const id = `${pkg.name}@${pkg.version}`;
    if (found.has(id)) return;
    found.set(id, dir);
    for (const dep of pkg.dependencies) {
      if (!NOT_BUNDLED.has(dep)) visit(join(dir, "..", dep));
    }
  };
  visit(join(import.meta.dir, "../node_modules/d3"));
  return found;
}

export function buildD3Notices(): string {
  const byText = new Map<string, string[]>();
  for (const [id, dir] of d3Tree()) {
    const text = readFileSync(join(dir, "LICENSE"), "utf-8").trim();
    byText.set(text, [...(byText.get(text) ?? []), id]);
  }
  const sections = [...byText].map(
    ([text, ids]) => `=== ${ids.toSorted().join(", ")} ===\n\n${text}\n`,
  );
  sections.sort();
  const intro =
    "Notices for d3 and the packages its bundled build (dist/d3.min.js) includes, which code-analysis serves to its --web pages. Each text is copied verbatim from the installed package LICENSE files named above it.";
  return `${intro}\n\n${sections.join("\n")}`;
}

if (import.meta.main) writeFileSync(D3_NOTICES_PATH, buildD3Notices());
