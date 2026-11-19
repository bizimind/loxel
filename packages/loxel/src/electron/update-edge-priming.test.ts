import { describe, expect, test } from "bun:test";

import { primeRangeRequests } from "./update-edge-priming";

describe("primeRangeRequests", () => {
  test("asks each URL for its first byte, then drops the response unread", async () => {
    const requests: { url: string; range: string | null }[] = [];
    const cancelled: string[] = [];
    const fetchFn = (url: string, init: RequestInit) => {
      requests.push({ url, range: new Headers(init.headers).get("range") });
      // A cold edge: the whole file, with a 200, here one that never ends.
      const body = new ReadableStream<Uint8Array>({
        pull: (controller) => controller.enqueue(new Uint8Array(1024)),
        cancel: () => {
          cancelled.push(url);
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    };

    await primeRangeRequests(["https://cdn.test/a.zip", "https://cdn.test/b.zip"], fetchFn);

    expect(requests).toEqual([
      { url: "https://cdn.test/a.zip", range: "bytes=0-0" },
      { url: "https://cdn.test/b.zip", range: "bytes=0-0" },
    ]);
    expect(cancelled.toSorted()).toEqual(["https://cdn.test/a.zip", "https://cdn.test/b.zip"]);
  });

  test("resolves when a URL cannot be reached", async () => {
    const failingFetch = () => Promise.reject(new Error("offline"));
    await expect(primeRangeRequests(["https://cdn.test/a.zip"], failingFetch)).resolves.toBe(
      undefined,
    );
  });
});
