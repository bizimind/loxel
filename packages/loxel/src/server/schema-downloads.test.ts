import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SchemaVerdict } from "./schema-consent";
import {
  lemminxCachePath,
  SchemaDownloads,
  schemaReferences,
  tombiCachePath,
} from "./schema-downloads";

describe("schemaReferences", () => {
  test("resolves a JSON Schema's $refs against its URL, leaving local ones", () => {
    const schema = JSON.stringify({
      $ref: "#/definitions/a",
      properties: {
        a: { $ref: "partial.json#/x" },
        b: { $ref: "https://other.example.org/b.json" },
        c: { $ref: "file:///etc/passwd" },
      },
    });
    expect(schemaReferences(schema, "https://example.com/dir/root.json").sort()).toEqual([
      "https://example.com/dir/partial.json",
      "https://other.example.org/b.json",
    ]);
  });

  test("finds an XSD's includes and a DTD's external entities", () => {
    const xsd = `<xs:schema><xs:include schemaLocation="common.xsd"/></xs:schema>`;
    expect(schemaReferences(xsd, "https://example.com/a/root.xsd")).toEqual([
      "https://example.com/a/common.xsd",
    ]);
    const dtd = `<!ENTITY % common SYSTEM "common.mod">`;
    expect(schemaReferences(dtd, "https://example.com/a/root.dtd")).toEqual([
      "https://example.com/a/common.mod",
    ]);
  });

  test("ignores the links of a page that is not a schema", () => {
    const html = `<html><a href="/login">Log in</a><a href="https://other.example/y">y</a></html>`;
    expect(schemaReferences(html, "https://example.com/a.json")).toEqual([]);
  });
});

describe("cache paths", () => {
  test("Tombi's: scheme, host and path, with an index file for names without .json", () => {
    expect(tombiCachePath("/c", "https://example.com/a/b.json")).toBe(
      "/c/https/example.com/a/b.json",
    );
    expect(tombiCachePath("/c", "https://example.com:8443/package")).toBe(
      "/c/https/example.com/package/__index__.json",
    );
  });

  test("LemMinX's: a cache folder, then scheme, host, port and decoded path", () => {
    expect(lemminxCachePath("/w", "https://example.com/a%20b/c.xsd")).toBe(
      "/w/cache/https/example.com/a b/c.xsd",
    );
    expect(lemminxCachePath("/w", "http://127.0.0.1:8080/c.xsd")).toBe(
      "/w/cache/http/127.0.0.1/8080/c.xsd",
    );
  });

  test("a URL cannot lead out of the cache", () => {
    expect(lemminxCachePath("/w", "https://example.com/%2e%2e/%2e%2e/%2e%2e/%2e%2e/x")).toBe(
      "/w/cache/https/example.com/x",
    );
    expect(lemminxCachePath("/w", "https://example.com/..%2f..%2f..%2f..%2f..%2fetc")).toBeNull();
    expect(lemminxCachePath("/w", "https://example.com/%ff")).toBeNull();
    expect(lemminxCachePath("/w", "https://evil.example/..%2Fother.example%2Fa.xsd")).toBeNull();
    expect(lemminxCachePath("/w", "https://evil.example/a%2Fb.xsd")).toBeNull();
    expect(tombiCachePath("/c", "http://../x.json")).toBeNull();
  });
});

describe("SchemaDownloads", () => {
  let root: string;
  let verdicts: Map<string, SchemaVerdict>;
  let fetched: string[];
  let responses: Map<string, string>;
  let restarts: number;
  let downloads: SchemaDownloads;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "schema-downloads-"));
    verdicts = new Map();
    fetched = [];
    responses = new Map();
    restarts = 0;
    downloads = new SchemaDownloads({
      tombiCacheDir: join(root, "tombi"),
      lemminxWorkDir: join(root, "lemminx"),
      fetchText: async (url) => {
        fetched.push(url);
        return responses.get(url) ?? null;
      },
      request: (url) => verdicts.get(url) ?? "undecided",
      addReferences: (rootUrl, references) => {
        for (const reference of references) {
          if (new URL(reference).origin === new URL(rootUrl).origin) {
            verdicts.set(reference, verdicts.get(rootUrl) ?? "undecided");
          }
        }
      },
      restartServers: () => {
        restarts++;
      },
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const A = "https://example.com/a.json";

  test("an undecided or denied URL is not fetched, and a server gets an empty schema", async () => {
    verdicts.set(A, "undecided");
    expect(await downloads.contentFor(A)).toBe("{}");
    verdicts.set(A, "denied");
    expect(await downloads.contentFor(A)).toBe("{}");
    await downloads.ensure([A]);
    expect(fetched).toEqual([]);
    expect(restarts).toBe(0);
  });

  test("an allowed URL is fetched for a server that asks", async () => {
    verdicts.set(A, "allowed");
    responses.set(A, `{"type":"object"}`);
    expect(await downloads.contentFor(A)).toBe(`{"type":"object"}`);
    expect(fetched).toEqual([A]);
  });

  test("a failed download is an error, not an empty schema", async () => {
    verdicts.set(A, "allowed");
    await expect(downloads.contentFor(A)).rejects.toThrow("Could not download");
  });

  test("ensure caches an allowed schema for both servers and restarts them once", async () => {
    verdicts.set(A, "allowed");
    responses.set(A, `{"type":"object"}`);
    await downloads.ensure([A]);
    expect(restarts).toBe(1);
    const tombi = tombiCachePath(join(root, "tombi"), A)!;
    const lemminx = lemminxCachePath(join(root, "lemminx"), A)!;
    expect(await Bun.file(tombi).text()).toBe(`{"type":"object"}`);
    expect(await Bun.file(lemminx).text()).toBe(`{"type":"object"}`);

    await downloads.ensure([A]);
    expect(fetched).toEqual([A]);
    expect(restarts).toBe(1);
  });

  test("references come along only when allowed", async () => {
    const sibling = "https://example.com/partial.json";
    const foreign = "https://other.example.org/b.json";
    verdicts.set(A, "allowed");
    responses.set(A, JSON.stringify({ a: { $ref: "partial.json" }, b: { $ref: foreign } }));
    responses.set(sibling, "{}");
    await downloads.ensure([A]);
    expect(fetched).toEqual([A, sibling]);
  });

  test("a schema that fails to download restarts nothing", async () => {
    verdicts.set(A, "allowed");
    await downloads.ensure([A]);
    expect(restarts).toBe(0);
  });

  test("a revocation stops a download under way from writing", async () => {
    let release = (_text: string) => {};
    const held = new Promise<string>((done) => {
      release = done;
    });
    const started = new Promise<void>((started) => {
      downloads = new SchemaDownloads({
        tombiCacheDir: join(root, "tombi"),
        lemminxWorkDir: join(root, "lemminx"),
        fetchText: async () => {
          started();
          return held;
        },
        request: () => "allowed",
        addReferences: () => {},
        restartServers: () => {},
      });
    });
    const running = downloads.ensure([A]);
    await started;
    await downloads.onRevoked();
    release("{}");
    await running;
    expect(await Bun.file(tombiCachePath(join(root, "tombi"), A)!).exists()).toBe(false);
  });

  test("a revocation during a cache write leaves nothing behind", async () => {
    let markRevoked = () => {};
    const revoked = new Promise<void>((done) => {
      markRevoked = done;
    });
    downloads = new SchemaDownloads({
      tombiCacheDir: join(root, "tombi"),
      lemminxWorkDir: join(root, "lemminx"),
      fetchText: async () => {
        // The next event-loop turn, while this download is writing on a fast enough machine. Whenever
        // it lands, nothing may remain once it has finished.
        setImmediate(() => {
          void downloads.onRevoked().then(markRevoked);
        });
        return "{}";
      },
      request: () => "allowed",
      addReferences: () => {},
      restartServers: () => {
        restarts++;
      },
    });
    await downloads.ensure([A]);
    await revoked;
    expect(await Bun.file(tombiCachePath(join(root, "tombi"), A)!).exists()).toBe(false);
    expect(await Bun.file(lemminxCachePath(join(root, "lemminx"), A)!).exists()).toBe(false);
  });

  test("a schema that cannot be cached does not restart the servers", async () => {
    const clash = "https://example.com/a.json/b.json";
    verdicts.set(A, "allowed");
    verdicts.set(clash, "allowed");
    responses.set(A, "{}");
    responses.set(clash, "{}");
    await downloads.ensure([A]);
    expect(restarts).toBe(1);
    await downloads.ensure([clash]);
    expect(restarts).toBe(1);
  });

  test("revoking empties the caches, so nothing is served without asking again", async () => {
    verdicts.set(A, "allowed");
    responses.set(A, "{}");
    await downloads.ensure([A]);
    await downloads.onRevoked();
    expect(restarts).toBe(2);
    expect(await Bun.file(tombiCachePath(join(root, "tombi"), A)!).exists()).toBe(false);
    expect(await Bun.file(lemminxCachePath(join(root, "lemminx"), A)!).exists()).toBe(false);
  });
});
