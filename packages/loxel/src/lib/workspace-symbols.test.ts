import { describe, expect, mock, test } from "bun:test";

import type { WorkspaceSymbolItem } from "@bizimind/monaco-lsp-client";
import * as monaco from "monaco-editor";

import type { WorkspaceSymbolResult, WorkspaceSymbolSource } from "./workspace-symbols";
import {
  rankWorkspaceSymbols,
  resolveWorkspaceSymbolLocation,
  searchWorkspaceSymbols,
} from "./workspace-symbols";

const WT = "/repo";
const { SymbolKind } = monaco.languages;

function item(
  name: string,
  uri: string,
  line = 1,
  extra: Partial<WorkspaceSymbolItem> = {},
): WorkspaceSymbolItem {
  return {
    name,
    kind: SymbolKind.Function,
    tags: [],
    containerName: undefined,
    uri,
    range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
    ...extra,
  };
}

function source(answer: () => Promise<WorkspaceSymbolItem[]>): WorkspaceSymbolSource {
  return { workspaceSymbols: () => answer(), resolveWorkspaceSymbol: async (symbol) => symbol };
}

const neverSource = source(() => Promise.resolve([]));

function rank(query: string, symbols: Array<[WorkspaceSymbolItem, string]>) {
  return rankWorkspaceSymbols(
    query,
    symbols.map(([symbol, filePath]) => ({ symbol, source: neverSource, filePath })),
    WT,
  ).map((r) => `${r.symbol.name} ${r.filePath}:${r.symbol.range?.startLineNumber}`);
}

describe("rankWorkspaceSymbols", () => {
  test("orders exact, case-insensitive exact, prefix, substring, subsequence, server-only", () => {
    const names = ["getUser", "user", "User", "useOfRange", "users", "loadUserAccounts", "ruse"];
    const ranked = rank(
      "User",
      names.map((n) => [item(n, `file://${WT}/a.ts`), `${WT}/a.ts`]),
    );
    expect(ranked.map((r) => r.split(" ")[0])).toEqual([
      "User",
      "user",
      "users",
      "getUser",
      "loadUserAccounts",
      "useOfRange",
      "ruse",
    ]);
  });

  test("puts project files before installed packages and outside files", () => {
    const ranked = rank("parse", [
      [item("parse", "file:///usr/lib/python3/json.py"), "/usr/lib/python3/json.py"],
      [item("parse", "file:///x"), `${WT}/node_modules/lib/index.d.ts`],
      [item("parse", "file:///x"), `${WT}/.venv/lib/python3.12/site-packages/p.py`],
      [item("parse", "file:///x"), `${WT}/src/parse.ts`],
      [item("parse", "file:///x"), `${WT}-other/src/parse.ts`],
    ]);
    expect(ranked[0]).toBe(`parse ${WT}/src/parse.ts:1`);
    expect(ranked.slice(1).sort()).toEqual(
      [
        `parse /usr/lib/python3/json.py:1`,
        `parse ${WT}/node_modules/lib/index.d.ts:1`,
        `parse ${WT}/.venv/lib/python3.12/site-packages/p.py:1`,
        `parse ${WT}-other/src/parse.ts:1`,
      ].sort(),
    );
  });

  test("breaks ties by name length, then path, then line", () => {
    const ranked = rank("run", [
      [item("runAll", "file:///x", 9), `${WT}/b.ts`],
      [item("running", "file:///x", 1), `${WT}/b.ts`],
      [item("runAll", "file:///x", 2), `${WT}/b.ts`],
      [item("runAll", "file:///x", 5), `${WT}/a.ts`],
      [item("runs", "file:///x", 1), `${WT}/z.ts`],
    ]);
    expect(ranked).toEqual([
      `runs ${WT}/z.ts:1`,
      `runAll ${WT}/a.ts:5`,
      `runAll ${WT}/b.ts:2`,
      `runAll ${WT}/b.ts:9`,
      `running ${WT}/b.ts:1`,
    ]);
  });

  test("keeps the same symbol once when two servers report it", () => {
    const ts = item("Config", `loxel://HEAD${WT}/src/config.ts`, 3);
    const astro = item("Config", `file://${WT}/src/config.ts`, 3);
    const other = item("Config", `file://${WT}/src/config.ts`, 8);
    expect(
      rank("Config", [
        [ts, `${WT}/src/config.ts`],
        [astro, `${WT}/src/config.ts`],
        [other, `${WT}/src/config.ts`],
      ]),
    ).toHaveLength(2);
  });

  test("keeps same-named symbols without a range apart by container", () => {
    const noRange = { range: undefined };
    expect(
      rank("__init__", [
        [item("__init__", "file:///x", 1, { ...noRange, containerName: "A" }), `${WT}/m.py`],
        [item("__init__", "file:///x", 1, { ...noRange, containerName: "B" }), `${WT}/m.py`],
      ]),
    ).toHaveLength(2);
  });

  test("returns the name's matched indices for highlighting", () => {
    const [result] = rankWorkspaceSymbols(
      "gu",
      [{ symbol: item("getUser", "file:///x"), source: neverSource, filePath: `${WT}/a.ts` }],
      WT,
    );
    expect(result?.indices).toEqual([0, 3]);
  });
});

describe("searchWorkspaceSymbols", () => {
  const token = new monaco.CancellationTokenSource().token;

  /** Runs a search and returns every `onResults` call as names plus the `done` flag. */
  async function search(
    sources: WorkspaceSymbolSource[],
    query: string,
    searchToken = token,
    timeoutMs = 1000,
  ) {
    const calls: Array<{ names: string[]; done: boolean; results: WorkspaceSymbolResult[] }> = [];
    await searchWorkspaceSymbols(
      sources,
      query,
      WT,
      searchToken,
      (results, done) => calls.push({ names: results.map((r) => r.symbol.name), done, results }),
      timeoutMs,
    );
    return calls;
  }

  test("merges every source's answer and maps file and loxel URIs to paths", async () => {
    const ts = source(async () => [item("parseConfig", `loxel://HEAD${WT}/src/my%20config.ts`)]);
    const py = source(async () => [item("parse", `file://${WT}/tool/parse.py`)]);

    const calls = await search([ts, py], "parse");

    expect(calls.at(-1)?.done).toBe(true);
    expect(calls.at(-1)?.results.map((r) => [r.symbol.name, r.filePath, r.source])).toEqual([
      ["parse", `${WT}/tool/parse.py`, py],
      ["parseConfig", `${WT}/src/my config.ts`, ts],
    ]);
  });

  test("reports a fast source before a slow one finishes", async () => {
    let answerSlow: (symbols: WorkspaceSymbolItem[]) => void = () => {};
    const slow = source(
      () =>
        new Promise((resolve) => {
          answerSlow = resolve;
        }),
    );
    const fast = source(async () => [item("fast", `file://${WT}/a.ts`)]);

    const searching = search([slow, fast], "f");
    await Bun.sleep(0);
    answerSlow([item("fastest", `file://${WT}/b.ts`)]);
    const calls = await searching;

    expect(calls.map(({ names, done }) => ({ names, done }))).toEqual([
      { names: ["fast"], done: false },
      { names: ["fast", "fastest"], done: true },
    ]);
  });

  test("cancels and leaves out a source that does not answer in time", async () => {
    let cancelled = false;
    const hung: WorkspaceSymbolSource = {
      workspaceSymbols: (_query, sourceToken) =>
        new Promise((_resolve, reject) => {
          sourceToken.onCancellationRequested(() => {
            cancelled = true;
            reject(new Error("Canceled"));
          });
        }),
      resolveWorkspaceSymbol: async (symbol) => symbol,
    };
    const ok = source(async () => [item("a", `file://${WT}/a.ts`)]);

    const calls = await search([hung, ok], "a", token, 20);

    expect(cancelled).toBe(true);
    expect(calls.at(-1)).toMatchObject({ names: ["a"], done: true });
  });

  test("leaves out a failing source and symbols whose URI cannot be opened", async () => {
    const failing = source(() => Promise.reject(new Error("server crashed")));
    const ok = source(async () => [
      item("a", `file://${WT}/a.ts`),
      item("b", "untitled:Untitled-1"),
      item("c", "not a uri"),
      item("d", `file://${WT}/bad%E0%A4%A.ts`),
    ]);

    const calls = await search([failing, ok], "");

    expect(calls.at(-1)?.names).toEqual(["a"]);
  });

  test("reports an empty, finished search when no server is connected", async () => {
    expect(await search([], "a")).toEqual([{ names: [], done: true, results: [] }]);
  });

  test("reports nothing once the token is cancelled", async () => {
    const tokens = new monaco.CancellationTokenSource();
    const slow = source(async () => {
      tokens.cancel();
      return [item("a", `file://${WT}/a.ts`)];
    });

    expect(await search([slow], "a", tokens.token)).toEqual([]);
  });
});

describe("resolveWorkspaceSymbolLocation", () => {
  function result(
    symbol: WorkspaceSymbolItem,
    resolve: WorkspaceSymbolSource["resolveWorkspaceSymbol"],
  ) {
    const src: WorkspaceSymbolSource = {
      workspaceSymbols: async () => [],
      resolveWorkspaceSymbol: resolve,
    };
    return { symbol, source: src, filePath: `${WT}/a.py`, indices: [] };
  }
  const rangeAt = (line: number, column: number) => ({
    startLineNumber: line,
    startColumn: column,
    endLineNumber: line,
    endColumn: column + 1,
  });

  test("opens at the range's start without asking the server", async () => {
    const resolve = mock(async (s: WorkspaceSymbolItem) => s);
    const location = await resolveWorkspaceSymbolLocation(
      result(item("a", "file:///x", 1, { range: rangeAt(4, 7) }), resolve),
      1000,
    );
    expect(location).toEqual({ line: 4, column: 7 });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("resolves a symbol that came without a range", async () => {
    const unresolved = item("a", "file:///x", 1, { range: undefined });
    const location = await resolveWorkspaceSymbolLocation(
      result(unresolved, async (s) => ({ ...s, range: rangeAt(9, 3) })),
      1000,
    );
    expect(location).toEqual({ line: 9, column: 3 });
  });

  test("falls back to the top of the file when resolving fails or hangs", async () => {
    const unresolved = item("a", "file:///x", 1, { range: undefined });
    const failed = await resolveWorkspaceSymbolLocation(
      result(unresolved, () => Promise.reject(new Error("boom"))),
      1000,
    );
    const hung = await resolveWorkspaceSymbolLocation(
      result(
        unresolved,
        (_s, token) =>
          new Promise((_resolve, reject) => {
            token.onCancellationRequested(() => reject(new Error("Canceled")));
          }),
      ),
      10,
    );
    expect(failed).toBeUndefined();
    expect(hung).toBeUndefined();
  });
});
