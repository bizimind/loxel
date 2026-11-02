import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Trust lives in the store database; keep the tests' state out of the real one.
const stateDir = await mkdtemp(join(tmpdir(), "routes-repo-trust-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { handleRequest } = await import("./routes");
const { isRepoTrusted, repoTrustId } = await import("./repo-trust");
type RouteContext = import("./routes").RouteContext;
type ProjectState = import("./server-state").ProjectState;

const root = await realpath(await mkdtemp(join(tmpdir(), "routes-repo-trust-")));
const wt = join(root, "wt");
await mkdir(wt);
await Bun.$`git init -q ${wt}`;
const project = { cwd: wt } as ProjectState;
const ctx = {
  findProjectForPath: (path: string) => (path === wt ? project : undefined),
} as RouteContext;

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

function setTrust(body: Record<string, unknown>): Promise<Response> {
  return handleRequest(
    new Request("http://x/api/repo-trust", { method: "POST", body: JSON.stringify(body) }),
    ctx,
  );
}

describe("/api/file-raw", () => {
  test("serves a project's file sandboxed, whatever its type", async () => {
    const page = join(wt, "page.html");
    await Bun.write(page, "<p>hello</p>");
    const url = `http://x/api/file-raw?path=page.html&wt=${encodeURIComponent(wt)}`;
    const requests: HeadersInit[] = [{}, { Range: "bytes=0-1" }];
    for (const headers of requests) {
      const response = await handleRequest(new Request(url, { headers }), ctx);
      expect(response.ok).toBe(true);
      expect(response.headers.get("Content-Security-Policy")).toBe("sandbox");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });
});

describe("/api/repo-trust", () => {
  test("reads, sets and revokes a worktree's repository trust", async () => {
    const read = await handleRequest(
      new Request(`http://x/api/repo-trust?wt=${encodeURIComponent(wt)}`),
      ctx,
    );
    expect(await read.json()).toEqual({ repository: wt, trusted: false, restrictions: [] });

    const trusted = await setTrust({ worktreePath: wt, trusted: true });
    expect(await trusted.json()).toEqual({ repository: wt, trusted: true, restrictions: [] });
    expect(isRepoTrusted(wt)).toBe(true);

    await setTrust({ worktreePath: wt, trusted: false });
    expect(isRepoTrusted(wt)).toBe(false);
  });

  test("needs an explicit answer and a known worktree", async () => {
    expect((await setTrust({ worktreePath: wt, trusted: "yes" })).status).toBe(400);
    expect((await setTrust({ worktreePath: join(root, "other"), trusted: true })).status).toBe(404);
    expect(isRepoTrusted(wt)).toBe(false);
  });

  test("the generic store route cannot write trust", async () => {
    const key = encodeURIComponent(`repo-trust:${repoTrustId(wt)}`);
    const response = await handleRequest(
      new Request(`http://x/api/stores/${key}`, {
        method: "PUT",
        body: JSON.stringify({ value: JSON.stringify({ fingerprint: "forged" }) }),
      }),
      ctx,
    );
    expect(response.status).toBe(403);
    expect(isRepoTrusted(wt)).toBe(false);
  });
});
