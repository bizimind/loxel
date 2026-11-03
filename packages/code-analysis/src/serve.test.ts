import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { VizTypeSchema } from "./plugin.ts";
import { buildHtml, D3_SCRIPT, D3_SCRIPT_PATH } from "./serve.ts";

// Any absolute or protocol-relative URL naming a host (`https://cdn.example.com`, `//cdn.example.com`).
const HOST_URL = /(?:[a-z][a-z0-9+.-]*:)?\/\/[\w-]+(?:\.[\w-]+)+/giu;

function loadD3(): Record<string, unknown> {
  const context: { d3?: Record<string, unknown> } = {};
  runInNewContext(D3_SCRIPT, context);
  if (!context.d3) throw new Error("the served d3 script did not define the d3 global");
  return context.d3;
}

describe.each(VizTypeSchema.options)("the %s page", (vizType) => {
  const html = buildHtml(vizType);

  test("names no external host, so it loads with no request off the machine", () => {
    expect(html.match(HOST_URL) ?? []).toEqual([]);
  });

  test("loads d3 from the local server before the page script uses it", () => {
    const d3Tag = html.indexOf(`<script src="${D3_SCRIPT_PATH}"></script>`);
    expect(d3Tag).toBeGreaterThanOrEqual(0);
    expect(d3Tag).toBeLessThan(html.indexOf('<script type="module">'));
  });

  test("uses only d3 functions the served build defines", () => {
    const d3 = loadD3();
    const pageScript = html.slice(html.indexOf('<script type="module">'));
    const used = new Set([...pageScript.matchAll(/\bd3\s*\.\s*(\w+)/gu)].map((match) => match[1]));
    expect(used.size).toBeGreaterThan(0);
    const missing = [...used].filter((name) => name === undefined || !Object.hasOwn(d3, name));
    expect(missing).toEqual([]);
  });
});

// d3's build bundles code from these packages beyond d3's own, under their own notices. Each is
// found next to the package that depends on it, as pnpm lays them out.
const BUNDLED_LICENSES: Array<{ name: string; from: string }> = [
  { name: "d3", from: "d3" },
  { name: "d3-delaunay", from: "d3" },
  { name: "d3-ease", from: "d3" },
  { name: "d3-geo", from: "d3" },
  { name: "d3-scale-chromatic", from: "d3" },
  { name: "delaunator", from: "d3-delaunay" },
];

function installedPackageDir(name: string, from: string): string {
  const d3Dir = realpathSync(join(import.meta.dir, "../node_modules/d3"));
  const fromDir = from === "d3" ? d3Dir : realpathSync(join(d3Dir, "..", from));
  return join(fromDir, "..", name);
}

test.each(BUNDLED_LICENSES)(
  "the served d3 script carries $name's license text, as installed",
  async ({ name, from }) => {
    const license = await Bun.file(join(installedPackageDir(name, from), "LICENSE")).text();
    expect(D3_SCRIPT.slice(0, D3_SCRIPT.indexOf("*/"))).toContain(license.trim());
  },
);

test("the served d3 script opens with its notices", () => {
  expect(D3_SCRIPT).toStartWith("/*!\nNotices for d3 ");
});
