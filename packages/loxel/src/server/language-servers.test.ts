import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { worktreeLspManagers } from "./language-servers";

const LOXEL = path.resolve(import.meta.dir, "../..");

describe("worktreeLspManagers", () => {
  // Only the servers that predate this list: a new server does not edit this test.
  test("keeps the original routes, each once", () => {
    const names = worktreeLspManagers.map((manager) => manager.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        "astro-lsp",
        "docker-lsp",
        "mypy-lsp",
        "python-lsp",
        "ruff-lsp",
        "terraform-lsp",
        "toml-lsp",
        "ts-lsp",
        "xml-lsp",
      ]),
    );
  });

  test("has a manager for every client route", async () => {
    const libDir = path.join(LOXEL, "src/lib");
    const files = readdirSync(libDir).filter((file) => file.endsWith("-lsp-client.ts"));
    const routes = await Promise.all(
      files.map(async (file) => {
        const source = await Bun.file(path.join(libDir, file)).text();
        return /route: "ws\/([^"]+)"/.exec(source)?.[1];
      }),
    );
    const names: (string | undefined)[] = worktreeLspManagers.map((manager) => manager.name);
    const missing = routes.filter((route) => route !== "yaml-lsp" && !names.includes(route));
    expect(missing).toEqual([]);
  });
});

describe("language-server binary manifests", () => {
  const dir = path.join(LOXEL, "scripts/language-servers");

  test("each names a script that exists", async () => {
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const manifest = (await Bun.file(path.join(dir, file)).json()) as { script: string };
      expect(existsSync(path.join(LOXEL, "scripts", manifest.script))).toBe(true);
    }
  });
});
