import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Trust lives in the store database; keep the tests' state out of the real one.
const stateDir = await mkdtemp(join(tmpdir(), "routes-repo-trust-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { handleRequest } = await import("./routes");
const { getRepoTrustStatus, isRepoTrusted, repoTrustId, setRepoTrusted } =
  await import("./repo-trust");
const projectStore = await import("./project-store");
type RouteContext = import("./routes").RouteContext;
type ProjectState = import("./server-state").ProjectState;
type RepoTrustListResponse = import("@/api/repo-trust-model").RepoTrustListResponse;

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
    expect(await read.json()).toEqual({ repository: wt, decision: "undecided", restrictions: [] });

    const trusted = await setTrust({ worktreePath: wt, decision: "trusted" });
    expect(await trusted.json()).toEqual({ repository: wt, decision: "trusted", restrictions: [] });
    expect(isRepoTrusted(wt)).toBe(true);

    const declined = await setTrust({ worktreePath: wt, decision: "declined" });
    expect(await declined.json()).toEqual({
      repository: wt,
      decision: "declined",
      restrictions: [],
    });
    expect(isRepoTrusted(wt)).toBe(false);
  });

  test("a stale Not Now does not take trust given meanwhile", async () => {
    await setTrust({ worktreePath: wt, decision: "trusted" });
    const stale = await setTrust({ worktreePath: wt, decision: "declined", unlessTrusted: true });
    expect(((await stale.json()) as { decision: string }).decision).toBe("trusted");
    expect(isRepoTrusted(wt)).toBe(true);
    await setTrust({ worktreePath: wt, decision: "undecided" });
  });

  test("needs an explicit answer and a known worktree", async () => {
    expect((await setTrust({ worktreePath: wt, decision: "yes" })).status).toBe(400);
    expect((await setTrust({ worktreePath: wt, trusted: true })).status).toBe(400);
    const unknown = await setTrust({ worktreePath: join(root, "other"), decision: "trusted" });
    expect(unknown.status).toBe(404);
    expect(isRepoTrusted(wt)).toBe(false);
  });

  test("forgets by repository id, which can only clear an answer", async () => {
    await setTrust({ worktreePath: wt, decision: "trusted" });
    const repositoryId = repoTrustId(wt);
    expect((await setTrust({ repositoryId, decision: "trusted" })).status).toBe(400);
    expect((await setTrust({ repositoryId, decision: "declined" })).status).toBe(400);
    expect(isRepoTrusted(wt)).toBe(true);

    expect((await setTrust({ repositoryId, decision: "undecided" })).ok).toBe(true);
    expect(getRepoTrustStatus(wt).decision).toBe("undecided");
  });

  test("lists every project's repository and every stored answer", async () => {
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    await Bun.$`git init -q ${elsewhere}`;
    await setTrust({ worktreePath: wt, decision: "declined" });
    // A project trusted once and removed since: its answer stays listed, with no worktree.
    setRepoTrusted(elsewhere, true);
    await projectStore.addProject(wt);
    // A bare project answers through its worktree, whose identity its root does not share.
    const bare = join(root, "bare");
    const bareWorktree = join(bare, ".worktrees", "main");
    await Bun.$`git -C ${wt} -c user.name=t -c user.email=t@t commit -q --allow-empty -m init`;
    await Bun.$`git clone -q --bare ${wt} ${bare}`;
    await Bun.$`git -C ${bare} worktree add -q ${bareWorktree}`;
    await projectStore.addProject(bare);

    const response = await handleRequest(new Request("http://x/api/repo-trust/list"), ctx);
    const { repositories } = (await response.json()) as RepoTrustListResponse;
    expect(
      repositories.map(({ repository, worktreePath, decision }) => ({
        repository,
        worktreePath,
        decision,
      })),
    ).toEqual([
      { repository: bare, worktreePath: bareWorktree, decision: "undecided" },
      { repository: elsewhere, worktreePath: null, decision: "trusted" },
      { repository: wt, worktreePath: wt, decision: "declined" },
    ]);
  });

  test("the generic store route cannot write trust or a decline", async () => {
    await setTrust({ worktreePath: wt, decision: "undecided" });
    for (const prefix of ["repo-trust:", "repo-trust-declined:"]) {
      const key = encodeURIComponent(`${prefix}${repoTrustId(wt)}`);
      const response = await handleRequest(
        new Request(`http://x/api/stores/${key}`, {
          method: "PUT",
          body: JSON.stringify({ value: JSON.stringify({ fingerprint: "forged" }) }),
        }),
        ctx,
      );
      expect(response.status).toBe(403);
    }
    expect(getRepoTrustStatus(wt).decision).toBe("undecided");
  });
});
