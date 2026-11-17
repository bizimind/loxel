import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { requestOpen, requestOpenAll } from "./open-request";

const SERVER = "http://127.0.0.1:7434";
const SOCKET = "/state/run/cli.sock";
const NO_WINDOW = { status: 503, body: { error: "No Loxel window is open" } };
/** No server listening: the old one exited and its replacement has not bound the port yet. */
const UNREACHABLE = "unreachable";

describe("requestOpen", () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | null = null;

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
  });

  /** Answer `/api/open` with the given responses in order, repeating the last one. */
  function serve(responses: Array<{ status: number; body: unknown } | typeof UNREACHABLE>): {
    bodies: unknown[];
    sockets: Array<string | undefined>;
  } {
    const bodies: unknown[] = [];
    const sockets: Array<string | undefined> = [];
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${SERVER}/api/open`);
      bodies.push(JSON.parse(String(init?.body)));
      sockets.push(init && "unix" in init ? String(init.unix) : undefined);
      const response = responses[Math.min(bodies.length - 1, responses.length - 1)]!;
      if (response === UNREACHABLE) throw new TypeError("fetch failed");
      return Response.json(response.body, { status: response.status });
    };
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(fakeFetch, { preconnect: globalThis.fetch.preconnect }),
    );
    return { bodies, sockets };
  }

  test("posts the request", async () => {
    const { bodies } = serve([{ status: 200, body: { ok: true } }]);

    await requestOpen(SERVER, { filePath: "/tmp/a.md", windowId: "w1" });

    expect(bodies).toEqual([{ filePath: "/tmp/a.md", windowId: "w1" }]);
  });

  test("posts a terminal request", async () => {
    const { bodies } = serve([{ status: 200, body: { ok: true, terminalId: "t" } }]);

    await requestOpen(SERVER, { terminal: { cwd: "/tmp", command: "ls" }, windowId: "w1" });

    expect(bodies).toEqual([{ terminal: { cwd: "/tmp", command: "ls" }, windowId: "w1" }]);
  });

  test("returns the server's warning", async () => {
    serve([{ status: 200, body: { ok: true, warning: "ignored" } }]);

    expect(await requestOpen(SERVER, { filePath: "/tmp" })).toEqual({ warning: "ignored" });
  });

  test("waits for a window to connect", async () => {
    const { bodies } = serve([NO_WINDOW, NO_WINDOW, { status: 200, body: { ok: true } }]);
    let waits = 0;

    await requestOpen(SERVER, { filePath: "/tmp/a.md" }, { onWaiting: () => waits++ });

    expect(bodies).toHaveLength(3);
    expect(waits).toBe(1);
  });

  test("retries while no server answers, as during a server handover", async () => {
    const { bodies } = serve([
      UNREACHABLE,
      NO_WINDOW,
      UNREACHABLE,
      { status: 200, body: { ok: true } },
    ]);

    await requestOpen(SERVER, { filePath: "/tmp/a.md" });

    expect(bodies).toHaveLength(4);
  });

  test("gives up when no server answers in time", async () => {
    serve([UNREACHABLE]);

    const result = requestOpen(SERVER, { filePath: "/tmp/a.md" }, { windowWaitMs: 0 });

    await expect(result).rejects.toThrow(`Cannot reach Loxel at ${SERVER}`);
  });

  test("sends every request over the Unix socket it is given", async () => {
    const { sockets } = serve([{ status: 200, body: { ok: true } }]);

    await requestOpenAll(SERVER, [{ filePath: "/a" }, { filePath: "/b" }], { unix: SOCKET });

    expect(sockets).toEqual([SOCKET, SOCKET]);
  });

  test("names the socket when no server answers on it", async () => {
    serve([UNREACHABLE]);

    const result = requestOpen(SERVER, { filePath: "/a" }, { unix: SOCKET, windowWaitMs: 0 });

    await expect(result).rejects.toThrow(`Cannot reach Loxel at ${SOCKET}`);
  });

  test("asks the server to queue at once when no window is coming", async () => {
    const { bodies } = serve([{ status: 202, body: { ok: true, queued: true } }]);
    let waits = 0;

    const result = await requestOpen(
      SERVER,
      { filePath: "/a" },
      { queueAfterMs: 0, onWaiting: () => waits++ },
    );

    expect(result).toEqual({ queued: true });
    expect(bodies).toEqual([{ filePath: "/a", queue: true }]);
    expect(waits).toBe(0);
  });

  test("queues once the wait for a launching window is over", async () => {
    const { bodies } = serve([NO_WINDOW, { status: 202, body: { ok: true, queued: true } }]);

    const result = await requestOpen(
      SERVER,
      { filePath: "/a" },
      { windowWaitMs: 0, queueAfterMs: 30_000 },
    );

    expect(result).toEqual({ queued: true });
    expect(bodies).toEqual([{ filePath: "/a" }, { filePath: "/a", queue: true }]);
  });

  test("waits for a launching window before letting the server queue", async () => {
    const { bodies } = serve([NO_WINDOW, { status: 202, body: { ok: true, queued: true } }]);
    // Every look at the clock is 10s later: the first retry is past the 15s it waits.
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => (now += 10_000));

    const result = await requestOpen(
      SERVER,
      { filePath: "/a" },
      { windowWaitMs: 60_000, queueAfterMs: 15_000 },
    ).finally(() => clock.mockRestore());

    expect(result).toEqual({ queued: true });
    expect(bodies).toEqual([{ filePath: "/a" }, { filePath: "/a", queue: true }]);
  });

  test("counts the requests the server queued", async () => {
    serve([{ status: 202, body: { ok: true, queued: true } }]);

    const result = await requestOpenAll(SERVER, [{ filePath: "/a" }, { filePath: "/b" }], {
      queueAfterMs: 0,
    });

    expect(result).toEqual({ warnings: [], queued: 2, failures: [] });
  });

  test("gives up when no window connects in time", async () => {
    serve([NO_WINDOW]);

    const result = requestOpen(SERVER, { filePath: "/tmp/a.md" }, { windowWaitMs: 0 });

    await expect(result).rejects.toThrow("No Loxel window is open");
  });

  test("reports the server's error without retrying", async () => {
    const { bodies } = serve([{ status: 404, body: { error: "File not found" } }]);

    await expect(requestOpen(SERVER, { filePath: "/tmp/nope.md" })).rejects.toThrow(
      "File not found",
    );
    expect(bodies).toHaveLength(1);
  });

  test("sends every request in order, reporting failures and going on after them", async () => {
    const { bodies } = serve([
      { status: 200, body: { ok: true } },
      { status: 404, body: { error: "File not found" } },
      { status: 200, body: { ok: true } },
    ]);

    const result = await requestOpenAll(SERVER, [
      { filePath: "/a" },
      { filePath: "/missing" },
      { url: "https://example.com", wtPath: "/wt" },
    ]);

    expect(bodies).toEqual([
      { filePath: "/a" },
      { filePath: "/missing" },
      { url: "https://example.com", wtPath: "/wt" },
    ]);
    expect(result).toEqual({
      warnings: [],
      queued: 0,
      failures: [{ index: 1, message: "File not found" }],
    });
  });

  test("reports each distinct warning once", async () => {
    serve([{ status: 200, body: { ok: true, warning: "ignored" } }]);

    const { warnings } = await requestOpenAll(SERVER, [{ filePath: "/a" }, { filePath: "/b" }]);

    expect(warnings).toEqual(["ignored"]);
  });

  test("shares one wait for a window across the requests", async () => {
    const { bodies } = serve([NO_WINDOW]);
    // Every look at the clock is 20s later, so the 30s budget is gone after the first request.
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => (now += 20_000));
    let waits = 0;

    const { failures } = await requestOpenAll(SERVER, [{ filePath: "/a" }, { filePath: "/b" }], {
      windowWaitMs: 30_000,
      onWaiting: () => waits++,
    });
    clock.mockRestore();

    expect(bodies).toHaveLength(2);
    expect(waits).toBe(1);
    expect(failures.map((f) => f.index)).toEqual([0, 1]);
  });
});
