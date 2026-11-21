import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { $ } from "bun";

import type { TempRepo } from "./git-commands/test-utils";
import { branch, checkoutBranch, commit, createRepo, writeFile } from "./git-commands/test-utils";
import type { RouteContext } from "./routes";
import { handleRequest } from "./routes";

let repo: TempRepo;
let ctx: RouteContext;

beforeAll(async () => {
  repo = await createRepo();
  await commit(repo.path, "init", { "notes.txt": "one\ntwo\nthree\n", "--output=x": "dashes\n" });
  // Git allows commas in branch names.
  await branch(repo.path, "topic,with,commas");
  await commit(repo.path, "on the comma branch", { "topic.txt": "topic\n" });
  await checkoutBranch(repo.path, "main");

  const project = { cwd: repo.path, isBare: false };
  ctx = { findProjectForPath: () => project } as unknown as RouteContext;
});

afterAll(() => repo.cleanup());

async function get<T>(path: string): Promise<[number, T]> {
  const res = await handleRequest(new Request(`http://x${path}`), ctx);
  return [res.status, (await res.json()) as T];
}

function query(params: Record<string, string>): string {
  return new URLSearchParams({ wt: repo.path, ...params }).toString();
}

describe("GET /api/log", () => {
  test("takes the branch list as a JSON array, keeping each name whole", async () => {
    const [status, commits] = await get<{ message: string }[]>(
      `/api/log?${query({ branches: JSON.stringify(["topic,with,commas"]) })}`,
    );
    expect(status).toBe(200);
    expect(commits.map((c) => c.message)).toEqual(["on the comma branch", "init"]);
  });

  test.each([JSON.stringify("main"), "main,other", JSON.stringify([1])])(
    "refuses a branch list that is not a JSON array of strings: %s",
    async (branches) => {
      const [status] = await get(`/api/log?${query({ branches })}`);
      expect(status).toBe(400);
    },
  );

  test("refuses a branch name that starts with a dash", async () => {
    const [status] = await get(`/api/log?${query({ branches: JSON.stringify(["-n", "1"]) })}`);
    expect(status).not.toBe(200);
  });
});

describe("GET /api/file-lines", () => {
  test("without a ref, reads the lines from the worktree on disk", async () => {
    await writeFile(repo.path, "notes.txt", "one\nTWO\nthree\n");
    const [status, body] = await get<{ lines: string[] }>(
      `/api/file-lines?${query({ path: "notes.txt", startLine: "2", endLine: "3" })}`,
    );
    expect(status).toBe(200);
    expect(body.lines).toEqual(["TWO", "three"]);
  });

  test("without a ref, reads the lines from the worktree the request names", async () => {
    const linked = `${repo.path}/.worktrees/linked`;
    await $`git -C ${repo.path} worktree add -q -b linked ${linked}`.quiet();
    await Bun.write(`${linked}/notes.txt`, "one\nlinked\nthree\n");
    const [status, body] = await get<{ lines: string[] }>(
      `/api/file-lines?${query({ path: "notes.txt", startLine: "2", endLine: "2", worktree: linked })}`,
    );
    expect(status).toBe(200);
    expect(body.lines).toEqual(["linked"]);
  });

  test("with a ref, reads the lines of the file at that ref", async () => {
    const [status, body] = await get<{ lines: string[] }>(
      `/api/file-lines?${query({ path: "notes.txt", startLine: "2", endLine: "2", ref: "HEAD" })}`,
    );
    expect(status).toBe(200);
    expect(body.lines).toEqual(["two"]);
  });

  test("reads a file whose name starts with dashes as a file", async () => {
    for (const ref of ["HEAD", undefined]) {
      const params = { path: "--output=x", startLine: "1", endLine: "1", ...(ref && { ref }) };
      const [status, body] = await get<{ lines: string[] }>(`/api/file-lines?${query(params)}`);
      expect(status).toBe(200);
      expect(body.lines).toEqual(["dashes"]);
    }
    expect(await Bun.file(`${repo.path}/x`).exists()).toBe(false);
  });
});

describe("POST /api/discard", () => {
  async function discard(files: string[]): Promise<number> {
    const body = JSON.stringify({ worktreePath: repo.path, files });
    const res = await handleRequest(
      new Request("http://x/api/discard", { method: "POST", body }),
      ctx,
    );
    return res.status;
  }

  test("takes an absolute path inside the worktree and discards that file", async () => {
    await writeFile(repo.path, "--output=x", "edited\n");
    expect(await discard([`${repo.path}/--output=x`])).toBe(200);
    expect(await Bun.file(`${repo.path}/--output=x`).text()).toBe("dashes\n");
  });

  test("refuses a path outside the worktree and the worktree itself", async () => {
    expect(await discard(["/etc/hosts"])).toBe(400);
    expect(await discard([repo.path])).toBe(400);
  });
});
