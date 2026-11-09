import { describe, expect, test } from "bun:test";

import { schemaGlobMatches, schemaUrlsNamedBy } from "./schema-references";

describe("schemaUrlsNamedBy", () => {
  test("finds a TOML directive, ignoring local paths", () => {
    expect(schemaUrlsNamedBy("toml", "#:schema https://example.com/a.json\nname = 1\n")).toEqual([
      "https://example.com/a.json",
    ]);
    expect(schemaUrlsNamedBy("toml", "#:schema ./schemas/a.json\n")).toEqual([]);
    expect(schemaUrlsNamedBy("toml", "name = 1\n")).toEqual([]);
  });

  test("finds every way an XML file names a schema", () => {
    const xml = `<?xml version="1.0"?>
<?xml-model href="https://example.com/model.rng"?>
<!DOCTYPE root SYSTEM "http://example.com/system.dtd">
<!DOCTYPE other PUBLIC "-//X//EN" "https://example.com/public.dtd">
<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:noNamespaceSchemaLocation="https://example.com/none.xsd"
  xsi:schemaLocation="http://example.com/ns https://example.com/a.xsd  urn:b b.xsd"/>`;
    expect(schemaUrlsNamedBy("xml", xml).sort()).toEqual([
      "http://example.com/system.dtd",
      "https://example.com/a.xsd",
      "https://example.com/model.rng",
      "https://example.com/none.xsd",
      "https://example.com/public.dtd",
    ]);
  });

  test("takes a TOML directive only from the leading comments", () => {
    const named = "# comment\n\n#:schema https://example.com/a.json\n";
    expect(schemaUrlsNamedBy("toml", named)).toEqual(["https://example.com/a.json"]);
    expect(schemaUrlsNamedBy("toml", "a = 1\n#:schema https://example.com/a.json\n")).toEqual([]);
  });

  test("names nothing in other languages", () => {
    expect(schemaUrlsNamedBy("yaml", "#:schema https://example.com/a.json")).toEqual([]);
  });
});

describe("schemaGlobMatches", () => {
  test("matches at any depth, with braces and dot directories", () => {
    expect(schemaGlobMatches("**/pyproject.toml", "/repo/sub/pyproject.toml")).toBe(true);
    expect(schemaGlobMatches("pyproject.toml", "/repo/pyproject.toml")).toBe(true);
    expect(schemaGlobMatches(".cargo/config.toml", "/repo/.cargo/config.toml")).toBe(true);
    expect(schemaGlobMatches("**/{ruff,.ruff}.toml", "/repo/.ruff.toml")).toBe(true);
    expect(schemaGlobMatches("**/pyproject.toml", "/repo/other.toml")).toBe(false);
    expect(schemaGlobMatches("/", "/repo/other.toml")).toBe(false);
  });
});
