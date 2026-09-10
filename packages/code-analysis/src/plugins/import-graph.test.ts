import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import importGraph from "./import-graph.ts";

test("includes local imports and excludes unresolved package imports", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "code-analysis-import-graph-"));
  try {
    await Promise.all([
      Bun.write(join(workDir, "index.ts"), 'import "./local.ts";\nimport "external-package";\n'),
      Bun.write(join(workDir, "local.ts"), "export const local = true;\n"),
    ]);

    const records = await importGraph.generate(workDir, {});

    expect(records).toHaveLength(1);
    const record = records[0];
    expect(typeof record?.source).toBe("string");
    expect(typeof record?.target).toBe("string");
    if (typeof record?.source !== "string" || typeof record.target !== "string") return;
    expect(basename(record.source)).toBe("index.ts");
    expect(basename(record.target)).toBe("local.ts");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
