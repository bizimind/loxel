/**
 * The terminal host must not load server code, directly or through anything it imports: it is
 * meant to run apart from the server and outlive it. See docs/TERMINAL_HOST.md.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "..");
const HOST_DIR = import.meta.dir;
const SERVER_DIR = join(SRC, "server");

/** Every module specifier in `source`: static and type imports, re-exports, `import()`. */
function specifiers(source: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
  return [...source.matchAll(pattern)].map((match) => match[1]!);
}

/** The source file `specifier` names from `fromFile`, or null for a package. */
function resolveLocal(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Cannot resolve ${specifier} from ${relative(SRC, fromFile)}`);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => join(dir, name));
}

/** Each file reachable from `entries`, with the chain of imports that reaches it. */
async function importGraph(entries: string[]): Promise<Map<string, string[]>> {
  const chains = new Map(entries.map((file) => [file, [file]]));
  const queue = [...entries];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const chain = chains.get(file)!;
    for (const specifier of specifiers(await Bun.file(file).text())) {
      const target = resolveLocal(specifier, file);
      if (target === null || chains.has(target)) continue;
      chains.set(target, [...chain, target]);
      queue.push(target);
    }
  }
  return chains;
}

describe("terminal host import boundary", () => {
  test("nothing under src/terminal-host/ reaches src/server/", async () => {
    const graph = await importGraph(sourceFiles(HOST_DIR));
    const violations = [...graph.values()]
      .filter((chain) => chain.at(-1)!.startsWith(`${SERVER_DIR}/`))
      .map((chain) => chain.map((file) => relative(SRC, file)).join(" -> "));
    expect(violations).toEqual([]);
  });

  test("the check sees through imports", async () => {
    // Guards the test above against passing vacuously: the server is reachable from itself.
    const graph = await importGraph([join(SERVER_DIR, "terminal-manager.ts")]);
    expect(graph.has(join(HOST_DIR, "terminal-session.ts"))).toBe(true);
    expect(graph.has(join(SERVER_DIR, "logger.ts"))).toBe(true);
  });
});
