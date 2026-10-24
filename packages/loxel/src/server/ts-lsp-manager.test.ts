import { describe, expect, test } from "bun:test";

import { toClientUris, toServerUris } from "./ts-lsp-manager";

describe("toServerUris", () => {
  test("translates TS/JS editor model URIs in any authority casing", () => {
    const body = JSON.stringify({
      params: { textDocument: { uri: "loxel://head/repo/src/a.ts" }, other: "loxel://HEAD/b.tsx" },
    });
    expect(JSON.parse(toServerUris(body))).toEqual({
      params: { textDocument: { uri: "file:///repo/src/a.ts" }, other: "file:///b.tsx" },
    });
  });

  test("leaves file:// JSON models and other loxel authorities alone", () => {
    const body = JSON.stringify({
      a: "file:///repo/package.json",
      b: "loxel://abc123/src/a.ts#old",
      c: "loxel://compare/repo/a.ts#p-new",
    });
    expect(toServerUris(body)).toBe(body);
  });
});

describe("toClientUris", () => {
  test("maps TS/JS files to loxel://HEAD and keeps JSON files on file://", () => {
    const body = JSON.stringify({
      changes: {
        "file:///repo/src/a.ts": [],
        "file:///repo/node_modules/x/index.d.ts": [],
        "file:///repo/package.json": [],
        "file:///repo/tsconfig.base.JSONC": [],
      },
    });
    expect(Object.keys(JSON.parse(toClientUris(body)).changes)).toEqual([
      "loxel://HEAD/repo/src/a.ts",
      "loxel://HEAD/repo/node_modules/x/index.d.ts",
      "file:///repo/package.json",
      "file:///repo/tsconfig.base.JSONC",
    ]);
  });

  test("keeps percent-encoded paths intact", () => {
    const body = JSON.stringify({ uri: "file:///my%20repo/a%40b.ts" });
    expect(JSON.parse(toClientUris(body))).toEqual({ uri: "loxel://HEAD/my%20repo/a%40b.ts" });
  });

  test("decides by the path, not a query, fragment or trailing markdown", () => {
    const value =
      "[a](file:///repo/a.ts#L3,5) [b](file:///repo/b.json#L1) see file:///repo/c.js?x=1.json";
    const body = JSON.stringify({ contents: { value } });
    expect(JSON.parse(toClientUris(body)).contents.value).toBe(
      "[a](loxel://HEAD/repo/a.ts#L3,5) [b](file:///repo/b.json#L1) see loxel://HEAD/repo/c.js?x=1.json",
    );
  });

  test("round-trips TS/JS URIs", () => {
    const body = JSON.stringify({ uri: "loxel://HEAD/repo/src/a.ts" });
    expect(toClientUris(toServerUris(body))).toBe(body);
  });
});
