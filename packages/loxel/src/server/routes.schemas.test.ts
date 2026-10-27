import { describe, expect, test } from "bun:test";

import type { RouteContext } from "./routes";
import { handleRequest } from "./routes";

describe("POST /api/schemas/sync", () => {
  test("resolves JSON schemas and routes YAML and TOML globs to their language servers", async () => {
    const resolved: string[] = [];
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
      updateYamlSchemas: (map) => {
        yamlMap = map;
      },
      updateTomlSchemas: (map) => {
        tomlMap = map;
      },
      formatContent: async () => ({ content: null }),
      getDetectedFormatters: () => [],
      setTerminalCommand: () => {},
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
    expect(resolved).toEqual([
      "https://json.schemastore.org/package",
      "https://example.com/pipfile.json",
    ]);
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
