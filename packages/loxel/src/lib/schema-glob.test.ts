import { describe, expect, test } from "bun:test";

import { classifySchemaGlob } from "./schema-glob";

describe("classifySchemaGlob", () => {
  test("routes a glob by the extension it ends with", () => {
    expect(classifySchemaGlob("**/tsconfig.json")).toEqual({
      json: true,
      yaml: false,
      toml: false,
    });
    expect(classifySchemaGlob("**/*.jsonc")).toEqual({ json: true, yaml: false, toml: false });
    expect(classifySchemaGlob("docker-compose.yml")).toEqual({
      json: false,
      yaml: true,
      toml: false,
    });
    expect(classifySchemaGlob("**/pyproject.toml")).toEqual({
      json: false,
      yaml: false,
      toml: true,
    });
    expect(classifySchemaGlob("**/{ruff,.ruff}.toml")).toEqual({
      json: false,
      yaml: false,
      toml: true,
    });
    expect(classifySchemaGlob("config/*.TOML").toml).toBe(true);
  });

  test("routes brace alternatives to each of their languages", () => {
    expect(classifySchemaGlob(".github/workflows/*.{yml,yaml}")).toEqual({
      json: false,
      yaml: true,
      toml: false,
    });
    expect(classifySchemaGlob("settings.{json,toml}")).toEqual({
      json: true,
      yaml: false,
      toml: true,
    });
  });

  test("applies a glob without a known extension to every language", () => {
    const all = { json: true, yaml: true, toml: true };
    expect(classifySchemaGlob("**/*")).toEqual(all);
    expect(classifySchemaGlob("**/Pipfile")).toEqual(all);
    expect(classifySchemaGlob("**/Cargo.lock")).toEqual(all);
  });
});
