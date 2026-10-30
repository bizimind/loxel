import { afterEach, describe, expect, test } from "bun:test";

import { SchemaService } from "./schema-service";

const SCHEMA = { type: "object" };

let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
});

/** Serves `/schema.json`; `/moved` redirects to it and `/loop` to itself. */
function serve(): { base: string; hits: string[] } {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const { pathname } = new URL(req.url);
      hits.push(pathname);
      if (pathname === "/moved") return Response.redirect("/schema.json", 302);
      if (pathname === "/loop") return Response.redirect("/loop", 302);
      return Response.json(SCHEMA);
    },
  });
  stop = () => server.stop(true);
  return { base: `http://127.0.0.1:${server.port}`, hits };
}

describe("SchemaService redirects", () => {
  test("follows one that is allowed", async () => {
    const { base, hits } = serve();
    const asked: [string, string][] = [];
    const service = new SchemaService((from, to) => {
      asked.push([from, to]);
      return true;
    });
    expect(await service.resolve(`${base}/moved`)).toEqual(SCHEMA);
    expect(asked).toEqual([[`${base}/moved`, `${base}/schema.json`]]);
    expect(hits).toEqual(["/moved", "/schema.json"]);
  });

  test("sends nothing to the target of one that is not", async () => {
    const { base, hits } = serve();
    const service = new SchemaService(() => false);
    expect(await service.resolve(`${base}/moved`)).toBeNull();
    expect(hits).toEqual(["/moved"]);
  });

  test("gives up on a redirect loop", async () => {
    const { base, hits } = serve();
    const service = new SchemaService(() => true);
    expect(await service.resolve(`${base}/loop`)).toBeNull();
    expect(hits).toHaveLength(6);
  });
});
