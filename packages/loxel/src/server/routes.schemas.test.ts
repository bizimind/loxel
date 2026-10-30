import { describe, expect, test } from "bun:test";

import type { RouteContext } from "./routes";
import { handleRequest } from "./routes";
import { SchemaConsent } from "./schema-consent";

function newConsent(): SchemaConsent {
  return new SchemaConsent({
    load: () => null,
    save: () => {},
    onStateChanged: () => {},
    onDecision: () => {},
  });
}

function resolveContext(
  consent: SchemaConsent,
  resolved: string[],
  ensured: (readonly string[])[] = [],
): RouteContext {
  return {
    schemaConsent: consent,
    ensureSchemas: async (urls: readonly string[]) => {
      ensured.push(urls);
    },
    resolveSchema: async (url: string) => {
      resolved.push(url);
      return { url };
    },
  } as unknown as RouteContext;
}

function resolveRequest(url: string): Request {
  const params = new URLSearchParams({ url });
  return new Request(`http://127.0.0.1:7434/api/schemas/resolve?${params.toString()}`);
}

function postRequest(path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1:7434${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/schemas/resolve", () => {
  const url = "http://127.0.0.1:9/private.json";

  test("does not fetch a URL before the user allows it, and asks", async () => {
    const consent = newConsent();
    consent.setConfigured([]);
    const resolved: string[] = [];
    const res = await handleRequest(resolveRequest(url), resolveContext(consent, resolved));
    expect(await res!.json()).toBeNull();
    expect(resolved).toEqual([]);
    expect(consent.state().pending).toEqual([url]);
  });

  test("fetches a trusted URL", async () => {
    const consent = newConsent();
    consent.decide(url, "trust");
    const resolved: string[] = [];
    const res = await handleRequest(resolveRequest(url), resolveContext(consent, resolved));
    expect(await res!.json()).toEqual({ url });
    expect(resolved).toEqual([url]);
  });

  test("does not fetch a denied URL, nor anything under never fetch", async () => {
    const consent = newConsent();
    const resolved: string[] = [];
    const ctx = resolveContext(consent, resolved);
    consent.decide(url, "deny");
    expect(await (await handleRequest(resolveRequest(url), ctx))!.json()).toBeNull();

    consent.decide(url, "trust");
    consent.setNeverFetch(true);
    expect(await (await handleRequest(resolveRequest(url), ctx))!.json()).toBeNull();
    expect(resolved).toEqual([]);
  });

  test("fetches a configured URL without asking, even under never fetch", async () => {
    const consent = newConsent();
    consent.setNeverFetch(true);
    consent.setConfigured([url]);
    const resolved: string[] = [];
    await handleRequest(resolveRequest(url), resolveContext(consent, resolved));
    expect(resolved).toEqual([url]);
  });

  test("reads a local path without a decision", async () => {
    const consent = newConsent();
    const resolved: string[] = [];
    await handleRequest(resolveRequest("./schema.json"), resolveContext(consent, resolved));
    expect(resolved).toEqual(["./schema.json"]);
    expect(consent.state().pending).toEqual([]);
  });
});

describe("schema consent routes", () => {
  test("record a decision and the switch, and validate what they get", async () => {
    const consent = newConsent();
    const ctx = resolveContext(consent, []);
    const url = "https://example.com/a.json";

    const trusted = await handleRequest(
      postRequest("/api/schemas/consent", { url, decision: "trust" }),
      ctx,
    );
    expect(trusted!.status).toBe(200);
    expect(consent.check(url)).toBe("allowed");

    const invalid = await handleRequest(
      postRequest("/api/schemas/consent", { url, decision: "maybe" }),
      ctx,
    );
    expect(invalid!.status).toBe(400);
    expect(consent.check(url)).toBe("allowed");

    await handleRequest(postRequest("/api/schemas/never-fetch", { neverFetch: true }), ctx);
    expect(consent.check(url)).toBe("denied");
  });

  test("ensure passes on remote URLs only", async () => {
    const ensured: (readonly string[])[] = [];
    const ctx = resolveContext(newConsent(), [], ensured);
    await handleRequest(
      postRequest("/api/schemas/ensure", {
        urls: ["https://example.com/a.json", "./local.json", 7],
      }),
      ctx,
    );
    expect(ensured).toEqual([["https://example.com/a.json"]]);
  });
});

describe("POST /api/schemas/sync", () => {
  test("downloads nothing and routes YAML and TOML globs to their language servers", async () => {
    const resolved: string[] = [];
    const consent = newConsent();
    let yamlMap: Record<string, string[]> | undefined;
    let tomlMap: Record<string, string[]> | undefined;
    const ctx: RouteContext = {
      broadcastToSubscribers: () => {},
      broadcastToProject: () => {},
      broadcastAll: () => {},
      sendToActiveWindow: () => false,
      sendToWorktreeWindows: () => {},
      externalFolderConflict: () => null,
      getProject: () => undefined,
      findProjectForPath: () => undefined,
      getWorktreeResources: () => undefined,
      suspendWorktreeWatchers: async () => async () => {},
      completeWorktreeRemoval: () => {},
      resolveFilePath: () => null,
      initializeProject: async () => ({ project: {} as never, worktrees: [] }),
      teardownProject: () => {},
      shutdown: () => {},
      resolveSchema: async (url) => {
        resolved.push(url);
        return { url };
      },
      schemaConsent: consent,
      ensureSchemas: async () => {},
      updateYamlSchemas: (map) => {
        yamlMap = map;
      },
      updateTomlSchemas: (map) => {
        tomlMap = map;
      },
      formatContent: async () => ({ content: null }),
      getDetectedFormatters: () => [],
      activeWindow: () => null,
      startTerminal: async () => {},
    };

    const pyproject = "https://json.schemastore.org/pyproject.json";
    const res = await handleRequest(
      new Request("http://127.0.0.1:7434/api/schemas/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schemas: [
            { glob: "**/package.json", url: "https://json.schemastore.org/package" },
            { glob: ".github/workflows/*.{yml,yaml}", url: "https://example.com/workflow.json" },
            { glob: "**/pyproject.toml", url: pyproject },
            { glob: "**/pyproject.*.toml", url: pyproject },
            { glob: "config/*.toml", url: "/schemas/my app.json" },
            { glob: "**/Pipfile", url: "https://example.com/pipfile.json" },
          ],
        }),
      }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(resolved).toEqual([]);
    expect(consent.check("https://json.schemastore.org/package")).toBe("allowed");
    expect(consent.check(pyproject)).toBe("allowed");
    expect(consent.check("https://elsewhere.example.com/a.json")).toBe("undecided");
    expect(yamlMap).toEqual({
      "https://example.com/workflow.json": [".github/workflows/*.{yml,yaml}"],
      "https://example.com/pipfile.json": ["**/Pipfile"],
    });
    expect(tomlMap).toEqual({
      [pyproject]: ["**/pyproject.toml", "**/pyproject.*.toml"],
      "file:///schemas/my%20app.json": ["config/*.toml"],
      "https://example.com/pipfile.json": ["**/Pipfile"],
    });
  });
});
