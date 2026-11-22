import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { SchemaService } from "./schema-service";

const SCHEMA = { type: "object" };

// The package's test run replaces `fetch` and `Response` with happy-dom's; this needs real sockets.
const domRegistered = GlobalRegistrator.isRegistered;
beforeAll(async () => {
  if (domRegistered) await GlobalRegistrator.unregister();
});
afterAll(() => {
  if (domRegistered) GlobalRegistrator.register();
});

let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
});

/** Serves `/schema.json`; `/moved` redirects to it, `/loop` to itself, and `/gone` is not found. */
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
      if (pathname === "/gone") return new Response("", { status: 404 });
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

describe("SchemaService download errors say why", () => {
  test("the status of a failed request", async () => {
    const { base } = serve();
    const service = new SchemaService(() => true);
    await expect(service.fetchText(`${base}/gone`)).rejects.toThrow("HTTP 404 Not Found");
  });

  test("a redirect it may not follow", async () => {
    const { base } = serve();
    const service = new SchemaService(() => false);
    await expect(service.fetchText(`${base}/moved`)).rejects.toThrow(
      `It redirects to ${base}/schema.json, which you haven't allowed`,
    );
  });

  test("a redirect loop", async () => {
    const { base } = serve();
    const service = new SchemaService(() => true);
    await expect(service.fetchText(`${base}/loop`)).rejects.toThrow("More than 5 redirects");
  });

  test("a host that does not answer", async () => {
    const { base } = serve();
    stop?.();
    stop = undefined;
    const service = new SchemaService(() => true);
    const { host } = new URL(base);
    await expect(service.fetchText(`${base}/schema.json`)).rejects.toThrow(
      `${host} refused the connection`,
    );
  });
});

describe("SchemaService local schemas", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "schema-service-"));
    await writeFile(join(dir, "schema.json"), JSON.stringify(SCHEMA));
    await symlink(join(dir, "schema.json"), join(dir, "linked.json"));
    await Bun.$`mkfifo ${join(dir, "pipe.json")}`;
    // Valid JSON just over the 5 MB inline limit.
    await writeFile(join(dir, "huge.json"), JSON.stringify({ pad: "x".repeat(5 * 1024 * 1024) }));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reads a schema file by relative or absolute path", async () => {
    const service = new SchemaService(() => false);
    expect(await service.resolve("./schema.json", dir)).toEqual(SCHEMA);
    expect(await service.resolve(join(dir, "schema.json"))).toEqual(SCHEMA);
  });

  test("follows a symlink to a schema file", async () => {
    const service = new SchemaService(() => false);
    expect(await service.resolve("linked.json", dir)).toEqual(SCHEMA);
  });

  test("skips a path that is not a regular file, without opening it", async () => {
    const service = new SchemaService(() => false);
    expect(await service.resolve("pipe.json", dir)).toBeNull();
  });

  test("skips a file larger than the inline limit", async () => {
    const service = new SchemaService(() => false);
    expect(await service.resolve("huge.json", dir)).toBeNull();
  });
});
