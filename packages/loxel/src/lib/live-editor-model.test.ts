import { describe, expect, test } from "bun:test";

import { editorFilePath, isLiveEditorModel } from "./live-editor-model";

const uri = (scheme: string, authority: string, fragment = "", query = "") => ({
  scheme,
  authority,
  path: "/repo/a b/ü.py",
  query,
  fragment,
});

describe("editorFilePath", () => {
  test("is the path of editor tab models, in any authority casing", () => {
    expect(editorFilePath(uri("file", ""))).toBe("/repo/a b/ü.py");
    expect(editorFilePath(uri("loxel", "HEAD"))).toBe("/repo/a b/ü.py");
    expect(editorFilePath(uri("loxel", "head"))).toBe("/repo/a b/ü.py");
  });

  test("is null for diff, history and compare sides", () => {
    expect(editorFilePath(uri("loxel", "HEAD", "new"))).toBeNull();
    expect(editorFilePath(uri("loxel", "abc123", "old"))).toBeNull();
    expect(editorFilePath(uri("loxel", "abc123"))).toBeNull();
    expect(editorFilePath(uri("loxel", "compare", "panel-1-old"))).toBeNull();
  });

  test("is null for other schemes and for URIs with a query", () => {
    expect(editorFilePath(uri("inmemory", "model"))).toBeNull();
    expect(editorFilePath(uri("untitled", ""))).toBeNull();
    expect(editorFilePath(uri("file", "", "", "x=1"))).toBeNull();
  });
});

describe("isLiveEditorModel", () => {
  test("accepts editor tab models and rejects the rest", () => {
    expect(isLiveEditorModel({ uri: uri("file", "") })).toBe(true);
    expect(isLiveEditorModel({ uri: uri("loxel", "HEAD") })).toBe(true);
    expect(isLiveEditorModel({ uri: uri("loxel", "HEAD", "new") })).toBe(false);
    expect(isLiveEditorModel({ uri: uri("inmemory", "model") })).toBe(false);
  });
});
