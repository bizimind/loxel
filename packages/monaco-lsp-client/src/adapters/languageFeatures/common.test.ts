import { describe, expect, mock, test } from "bun:test";

import type * as monaco from "monaco-editor";

import { fakeMonacoModule } from "../../testing/fake-monaco";

mock.module("monaco-editor", () => fakeMonacoModule);

const { matchesDocumentSelector } = await import("./common");

function fakeModel(languageId: string, path = "/a.py") {
  return {
    getLanguageId: () => languageId,
    uri: { scheme: "loxel", path },
  } as unknown as monaco.editor.ITextModel;
}

describe("matchesDocumentSelector", () => {
  test("a null or empty selector falls back to the client's language ids", () => {
    expect(matchesDocumentSelector(fakeModel("python"), null, ["python"])).toBe(true);
    expect(matchesDocumentSelector(fakeModel("typescript"), null, ["python"])).toBe(false);
    expect(matchesDocumentSelector(fakeModel("typescript"), [], ["python"])).toBe(false);
  });

  test("a null selector matches every model when the client has no language ids", () => {
    expect(matchesDocumentSelector(fakeModel("typescript"), null)).toBe(true);
  });

  test("typescript and javascript filters also match tsx and jsx models", () => {
    expect(matchesDocumentSelector(fakeModel("tsx"), [{ language: "typescript" }])).toBe(true);
    expect(matchesDocumentSelector(fakeModel("jsx"), [{ language: "javascript" }])).toBe(true);
    expect(matchesDocumentSelector(fakeModel("tsx"), [{ language: "javascript" }])).toBe(false);
  });
});
