import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FormatService } from "./format-service";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function makeWorktree(files: Record<string, string>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "format-service-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content);
  }
  return root;
}

function findFormatter(service: FormatService, wt: string, command: string) {
  return service.getDetectedFormatters(wt).find((f) => f.command === command);
}

describe("FormatService auto-detection", () => {
  test("detects oxfmt from a devDependency and claims md (and other oxfmt-supported extensions)", async () => {
    const wt = await makeWorktree({
      "package.json": JSON.stringify({ devDependencies: { oxfmt: "0.68.0" } }),
    });
    const service = new FormatService();
    const detected = service.getDetectedFormatters(wt);
    expect(detected.map((f) => f.command)).toEqual(["oxfmt"]);

    const oxfmt = findFormatter(service, wt, "oxfmt");
    expect(oxfmt).toBeDefined();
    for (const ext of ["ts", "md", "json", "yaml", "toml", "html", "vue", "scss", "graphql"]) {
      expect(oxfmt!.extensions).toContain(ext);
    }
    // Not formatted by default in oxfmt 0.68 — must not be claimed.
    expect(oxfmt!.extensions).not.toContain("svelte");
    expect(oxfmt!.extensions).not.toContain("astro");
  });

  test("detects oxfmt from .oxfmtrc.jsonc without a package.json", async () => {
    const wt = await makeWorktree({ ".oxfmtrc.jsonc": "{}" });
    const service = new FormatService();
    expect(findFormatter(service, wt, "oxfmt")?.extensions).toContain("md");
  });

  test("lists prettier before oxfmt when both are detected (prettier wins for md)", async () => {
    // `format()` walks detected formatters in order and uses the first one whose extension set
    // contains the file's extension. Detection rules are ordered prettier → oxfmt, so a project
    // with both formatters keeps using prettier for shared extensions such as md/json.
    const wt = await makeWorktree({
      ".prettierrc": "{}",
      "package.json": JSON.stringify({ devDependencies: { oxfmt: "0.68.0", prettier: "3.0.0" } }),
    });
    const service = new FormatService();
    const detected = service.getDetectedFormatters(wt);
    expect(detected.map((f) => f.command)).toEqual(["prettier", "oxfmt"]);

    // Every extension oxfmt claims that prettier can also format must route to prettier, so
    // alias spellings (yml, mjs, scss, mdx, ...) do not silently diverge from the canonical ones.
    const oxfmt = findFormatter(service, wt, "oxfmt")!;
    const prettier = findFormatter(service, wt, "prettier")!;
    for (const ext of oxfmt.extensions) {
      const first = detected.find((f) => f.extensions.includes(ext));
      expect(first?.command, `first formatter for .${ext}`).toBe(
        ext === "toml" ? "oxfmt" : "prettier",
      );
    }
    expect(prettier.extensions).toContain("md");
  });

  test("detects nothing in an empty worktree", async () => {
    const wt = await makeWorktree({});
    const service = new FormatService();
    expect(service.getDetectedFormatters(wt)).toEqual([]);
  });
});
