import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as api from "./client";
import { getGoEnv, setGoToolchainChoice } from "./go-env-client";
import { localServerId } from "./local-server";
import { listRepoTrust } from "./repo-trust-client";
import {
  ApiError,
  connectionOf,
  hasConnection,
  registerConnection,
  ServerConnection,
} from "./server-connection";
import { toServerId, worktreeRef } from "./worktree-ref";

/** A second server, holding the same paths as the window's own. */
const OTHER = toServerId("other-server");
/** A server the window has no connection to. */
const UNKNOWN = toServerId("unknown-server");

let requests: Array<{ url: string; body: unknown }> = [];
let status = 200;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let unregister: () => void;
let otherWs: api.WsClient;

beforeEach(() => {
  requests = [];
  status = 200;
  otherWs = new api.WsClient();
  unregister = registerConnection(
    new ServerConnection({ server: OTHER, baseUrl: "/peers/other-server", ws: otherWs }),
  );
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ url: String(input), body });
    return new Response(JSON.stringify(status === 200 ? {} : { error: "refused" }), { status });
  }) as typeof fetch);
});

afterEach(() => {
  unregister();
  fetchSpy.mockRestore();
});

describe("server connections", () => {
  test("a worktree's request goes to its own server's connection, whatever its path", async () => {
    await api.getStatus(worktreeRef(OTHER, "/repo"));
    await api.getStatus(worktreeRef(localServerId(), "/repo"));
    expect(requests.map((r) => r.url)).toEqual([
      "/peers/other-server/api/status?wt=%2Frepo",
      "/api/status?wt=%2Frepo",
    ]);
  });

  test("bodies carry the bare path, and server-wide calls take the server", async () => {
    await api.stageFiles(worktreeRef(OTHER, "/repo"), ["a.ts"]);
    await api.getProjects(OTHER);
    await setGoToolchainChoice(worktreeRef(OTHER, "/repo"), { goPath: null });
    await getGoEnv(worktreeRef(OTHER, "/repo"));
    await listRepoTrust(OTHER);
    expect(requests).toEqual([
      { url: "/peers/other-server/api/stage", body: { worktreePath: "/repo", files: ["a.ts"] } },
      { url: "/peers/other-server/api/projects", body: undefined },
      {
        url: "/peers/other-server/api/go-env/choice",
        body: { worktreePath: "/repo", goPath: null },
      },
      { url: "/peers/other-server/api/go-env?wt=%2Frepo", body: undefined },
      { url: "/peers/other-server/api/repo-trust/list", body: undefined },
    ]);
  });

  test("a file read with a worktree hint goes to the file's server", async () => {
    await api.getFileContentByPath(OTHER, "/repo/a.ts", worktreeRef(OTHER, "/repo"));
    await api.writeFileContent(OTHER, {
      path: "/repo/a.ts",
      content: "x",
      nonce: "n",
      worktree: worktreeRef(OTHER, "/repo"),
    });
    expect(requests).toEqual([
      {
        url: "/peers/other-server/api/file-content?path=%2Frepo%2Fa.ts&wt=%2Frepo",
        body: undefined,
      },
      {
        url: "/peers/other-server/api/file-write",
        body: { path: "/repo/a.ts", content: "x", nonce: "n", worktreePath: "/repo" },
      },
    ]);
  });

  test("a worktree hint on another server than the file's is refused before any request", async () => {
    const read = api.getFileContentByPath(
      OTHER,
      "/repo/a.ts",
      worktreeRef(localServerId(), "/repo"),
    );
    await expect(read).rejects.toThrow("is not on server other-server");
    expect(requests).toEqual([]);
  });

  test("a worktree of an unconnected server sends nothing, to it or to the window's server", async () => {
    const wt = worktreeRef(UNKNOWN, "/repo");
    expect(hasConnection(UNKNOWN)).toBe(false);
    const calls = [
      api.getStatus(wt),
      api.getDiff(wt, { staged: true }),
      api.getDirContents(wt, ""),
      api.getFileIndex(wt),
      api.getGraph(wt),
      api.getFileContentByPath(UNKNOWN, "/repo/a.ts", wt),
      getGoEnv(wt),
    ];
    for (const call of calls) await expect(call).rejects.toThrow("No connection to server");
    expect(requests).toEqual([]);
  });

  test("a refused session expires only that connection's socket", async () => {
    status = 401;
    const expired = spyOn(otherWs, "expireSession").mockImplementation(() => {});
    const localExpired = spyOn(connectionOf(localServerId()).ws, "expireSession");
    await expect(api.getStatus(worktreeRef(OTHER, "/repo"))).rejects.toBeInstanceOf(ApiError);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(localExpired).not.toHaveBeenCalled();
    localExpired.mockRestore();
  });

  test("a server has one connection", () => {
    const again = new ServerConnection({ server: OTHER, baseUrl: "/x", ws: otherWs });
    expect(() => registerConnection(again)).toThrow("already has a connection");
  });
});
