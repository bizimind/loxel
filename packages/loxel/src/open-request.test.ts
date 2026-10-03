import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { requestOpen } from "./open-request";

const SERVER = "http://127.0.0.1:7434";
const NO_WINDOW = { status: 503, body: { error: "No Loxel window is open" } };

describe("requestOpen", () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | null = null;

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
  });

  /** Answer `/api/open` with the given responses in order, repeating the last one. */
  function serve(responses: Array<{ status: number; body: unknown }>): { bodies: unknown[] } {
    const bodies: unknown[] = [];
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${SERVER}/api/open`);
      bodies.push(JSON.parse(String(init?.body)));
      const { status, body } = responses[Math.min(bodies.length - 1, responses.length - 1)]!;
      return Response.json(body, { status });
    };
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(fakeFetch, { preconnect: globalThis.fetch.preconnect }),
    );
    return { bodies };
  }

  test("posts the request", async () => {
    const { bodies } = serve([{ status: 200, body: { ok: true } }]);

    await requestOpen(SERVER, { filePath: "/tmp/a.md", windowId: "w1" });

    expect(bodies).toEqual([{ filePath: "/tmp/a.md", windowId: "w1" }]);
  });

  test("waits for a window to connect", async () => {
    const { bodies } = serve([NO_WINDOW, NO_WINDOW, { status: 200, body: { ok: true } }]);
    let waits = 0;

    await requestOpen(SERVER, { filePath: "/tmp/a.md" }, { onWaiting: () => waits++ });

    expect(bodies).toHaveLength(3);
    expect(waits).toBe(1);
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
});
