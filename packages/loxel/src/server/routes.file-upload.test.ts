import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { DetachedFilesService } from "./detached-files-service";
import { MAX_IMAGE_UPLOAD_BYTES } from "./image-upload";
import type { RouteContext } from "./routes";
import { handleRequest } from "./routes";
import type { ResolvedFilePath, WorktreeResources } from "./server-state";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("POST /api/file-upload", () => {
  let root: string;
  let wt: string;
  let detachedDir: string;
  let service: DetachedFilesService;
  let ctx: RouteContext;
  const nonceWrites: string[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "loxel-upload-"));
    wt = join(root, "worktree");
    detachedDir = join(root, "detached");
    await mkdir(join(wt, "docs"), { recursive: true });
    await mkdir(detachedDir, { recursive: true });
    await writeFile(join(wt, "docs", "plan.md"), "# plan");
    await writeFile(join(detachedDir, "Note 1.md"), "draft");

    service = new DetachedFilesService(detachedDir, () => {});
    await service.start();
    nonceWrites.length = 0;

    const resources = {
      detachedFilesService: service,
      filesService: {
        writeFile: async (path: string, nonce: string, fn: () => Promise<void>) => {
          nonceWrites.push(`${path}:${nonce}`);
          await fn();
        },
      },
      externalFilesService: { hasFile: () => false },
    } as unknown as WorktreeResources;

    // Mirrors the server's resolveFilePath: normalize then prefix-match.
    const resolveFilePath = (absolutePath: string): ResolvedFilePath | null => {
      const normalized = resolve(absolutePath);
      if (normalized.startsWith(detachedDir + "/")) {
        return { type: "detached", wtPath: wt, resources, name: normalized.split("/").pop()! };
      }
      if (normalized.startsWith(wt + "/")) {
        return {
          type: "project",
          wtPath: wt,
          resources,
          relativePath: normalized.slice(wt.length + 1),
        };
      }
      if (normalized === join(root, "external.md")) {
        return { type: "external", wtPath: wt, resources, absolutePath: normalized };
      }
      return null;
    };

    ctx = {
      broadcastToSubscribers: () => {},
      broadcastToProject: () => {},
      broadcastAll: () => {},
      getProject: () => undefined,
      findProjectForPath: () => undefined,
      getWorktreeResources: (path) => (path === wt ? resources : undefined),
      suspendWorktreeWatchers: async () => async () => {},
      completeWorktreeRemoval: () => {},
      resolveFilePath,
      initializeProject: async () => ({ project: {} as never, worktrees: [] }),
      teardownProject: () => {},
      shutdown: () => {},
      resolveSchema: async () => ({}),
      updateYamlSchemas: () => {},
      formatContent: async () => null,
      getDetectedFormatters: () => [],
    };
  });

  afterEach(async () => {
    service.stop();
    await rm(root, { recursive: true, force: true });
  });

  test("stores a project image under <md dir>/assets and returns a relative src", async () => {
    const res = await upload({ path: join(wt, "docs", "plan.md"), file: png("Shot One.png") });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.src).toMatch(/^\.\/assets\/shot-one-\d{8}-\d{6}\.png$/);
    expect(body.path).toBe(join(wt, "docs", body.src.slice(2)));
    expect(new Uint8Array(await readFile(body.path))).toEqual(PNG);
    expect(nonceWrites).toEqual([`docs/${body.src.slice(2)}:nonce-1`]);
  });

  test("stores a draft image flat in the drafts directory", async () => {
    const res = await upload({ path: join(detachedDir, "Note 1.md"), file: png("shot.png") });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.src).toMatch(/^\.\/shot-\d{8}-\d{6}\.png$/);
    expect(body.path).toBe(join(detachedDir, body.src.slice(2)));
    expect(existsSync(body.path)).toBe(true);
  });

  test("never overwrites: a same-second clash gets a numbered suffix", async () => {
    const path = join(wt, "docs", "plan.md");
    const first = await (await upload({ path, file: png("shot.png") })).json();
    const second = await (await upload({ path, file: png("shot.png") })).json();
    expect(second.src).toBe(first.src.replace(/\.png$/, "-2.png"));

    const draft = join(detachedDir, "Note 1.md");
    const d1 = await (await upload({ path: draft, file: png("shot.png") })).json();
    const d2 = await (await upload({ path: draft, file: png("shot.png") })).json();
    expect(d2.src).toBe(d1.src.replace(/\.png$/, "-2.png"));
  });

  test("derives the extension from content, not the declared name or mime", async () => {
    const res = await upload({
      path: join(wt, "docs", "plan.md"),
      file: new File([PNG], "evil.html", { type: "image/jpeg" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).src).toMatch(/^\.\/assets\/evil-\d{8}-\d{6}\.png$/);
  });

  test("rejects path traversal and paths outside active worktrees", async () => {
    for (const path of [
      join(wt, "..", "outside.md"),
      join(wt, "docs", "..", "..", "x.md"),
      "/etc/passwd",
      join(detachedDir, "..", "worktree", "..", "..", "y.md"),
    ]) {
      const res = await upload({ path, file: png("a.png") });
      expect(res.status).toBe(404);
    }
    const relative = await upload({ path: "docs/plan.md", file: png("a.png") });
    expect(relative.status).toBe(400);
    expect(await readdir(join(wt, "docs"))).toEqual(["plan.md"]);
  });

  test("rejects external files (outside the worktree)", async () => {
    const res = await upload({ path: join(root, "external.md"), file: png("a.png") });
    expect(res.status).toBe(400);
  });

  test("rejects non-image mime types and non-image content", async () => {
    const mime = await upload({
      path: join(wt, "docs", "plan.md"),
      file: new File([PNG], "a.png", { type: "text/plain" }),
    });
    expect(mime.status).toBe(415);

    const content = await upload({
      path: join(wt, "docs", "plan.md"),
      file: new File(["<script>alert(1)</script>"], "a.png", { type: "image/png" }),
    });
    expect(content.status).toBe(415);
    expect(existsSync(join(wt, "docs", "assets"))).toBe(false);
  });

  test("rejects files over the size limit", async () => {
    const big = new Uint8Array(MAX_IMAGE_UPLOAD_BYTES + 1);
    big.set(PNG);
    const res = await upload({
      path: join(wt, "docs", "plan.md"),
      file: new File([big], "big.png", { type: "image/png" }),
    });
    expect(res.status).toBe(413);
  });

  test("rejects missing nonce and non-multipart bodies", async () => {
    const form = new FormData();
    form.set("path", join(wt, "docs", "plan.md"));
    form.set("file", png("a.png"));
    const noNonce = await handleRequest(
      new Request("http://localhost/api/file-upload", { method: "POST", body: form }),
      ctx,
    );
    expect(noNonce.status).toBe(400);

    const jsonBody = await handleRequest(
      new Request("http://localhost/api/file-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "x" }),
      }),
      ctx,
    );
    expect(jsonBody.status).toBe(400);
  });

  function png(name: string): File {
    return new File([PNG], name, { type: "image/png" });
  }

  function upload(options: { path: string; file: File }): Promise<Response> {
    const form = new FormData();
    form.set("path", options.path);
    form.set("nonce", "nonce-1");
    form.set("file", options.file, options.file.name);
    return handleRequest(
      new Request("http://localhost/api/file-upload", { method: "POST", body: form }),
      ctx,
    );
  }
});
