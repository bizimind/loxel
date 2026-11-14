import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

import { buildD3Notices, D3_NOTICES_PATH } from "./d3-notices.ts";
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

test("the shipped d3 notices match d3's installed dependency tree", async () => {
  // Fails after the installed d3 tree changes; regenerate with `bun src/d3-notices.ts`.
  const notices = await Bun.file(D3_NOTICES_PATH).text();
  expect(notices).toBe(buildD3Notices());
  expect(notices).toContain("Based on https://github.com/mourner/quickselect");
  expect(notices).toContain("ISC license, Copyright 2018 Vladimir Agafonkin.");
});

test("the served d3 script opens with the shipped notices", async () => {
  expect(D3_SCRIPT).toStartWith(`/*!\n${await Bun.file(D3_NOTICES_PATH).text()}*/\n`);
});
