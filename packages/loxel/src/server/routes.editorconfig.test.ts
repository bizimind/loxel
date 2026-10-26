import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RouteContext } from "./routes";
import { handleRequest } from "./routes";
import type { ResolvedFilePath, WorktreeResources } from "./server-state";

describe("GET /api/editorconfig", () => {
  let root: string;
  let wt: string;
  let ctx: RouteContext;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "loxel-routes-editorconfig-")));
    wt = join(root, "worktree");
    await mkdir(join(wt, "src"), { recursive: true });
    // Above the worktree root, so never read.
    await writeFile(join(root, ".editorconfig"), "[*]\nend_of_line = crlf\n");
    await writeFile(join(wt, ".editorconfig"), "[*.py]\nindent_style = space\nindent_size = 4\n");

    const resources = {} as WorktreeResources;
    const resolveFilePath = (path: string): ResolvedFilePath | null => {
      if (path.startsWith(join(root, "drafts") + "/")) {
        return { type: "detached", wtPath: wt, resources, name: "Draft.py" };
      }
      if (!path.startsWith(wt + "/")) return null;
      const tree = { root: wt } as Extract<ResolvedFilePath, { type: "tree" }>["tree"];
      return { type: "tree", wtPath: wt, resources, tree, relativePath: path.slice(wt.length + 1) };
    };
    ctx = { resolveFilePath } as unknown as RouteContext;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function get(path: string): Promise<unknown> {
    const url = `http://localhost/api/editorconfig?path=${encodeURIComponent(path)}&wt=${encodeURIComponent(wt)}`;
    const res = await handleRequest(new Request(url), ctx);
    expect(res.status).toBe(200);
    return res.json();
  }

  test("resolves a worktree file up to the worktree root", async () => {
    expect(await get(join(wt, "src/app.py"))).toEqual({
      properties: { indentStyle: "space", indentSize: 4, tabWidth: 4 },
    });
    // A file that does not exist yet (a new file) resolves the same way.
    expect(await get(join(wt, "src/new.py"))).toEqual({
      properties: { indentStyle: "space", indentSize: 4, tabWidth: 4 },
    });
  });

  test("returns nothing for drafts and paths outside every tree", async () => {
    expect(await get(join(root, "drafts/Draft.py"))).toEqual({ properties: {} });
    expect(await get(join(root, "elsewhere.py"))).toEqual({ properties: {} });
  });

  test("rejects a relative path", async () => {
    const res = await handleRequest(
      new Request("http://localhost/api/editorconfig?path=a.py"),
      ctx,
    );
    expect(res.status).toBe(400);
  });
});
