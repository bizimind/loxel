import { describe, expect, test } from "bun:test";

import { isLiveEditorModel } from "./live-editor-model";

const model = (scheme: string, authority: string, fragment = "") => ({
  uri: { scheme, authority, fragment },
});

describe("isLiveEditorModel", () => {
  test("accepts editor tab models", () => {
    expect(isLiveEditorModel(model("file", ""))).toBe(true);
    expect(isLiveEditorModel(model("loxel", "HEAD"))).toBe(true);
  });

  test("rejects diff, history and compare sides", () => {
    expect(isLiveEditorModel(model("loxel", "HEAD", "new"))).toBe(false);
    expect(isLiveEditorModel(model("loxel", "abc123", "old"))).toBe(false);
    expect(isLiveEditorModel(model("loxel", "compare", "panel-1-old"))).toBe(false);
  });

  test("rejects other schemes", () => {
    expect(isLiveEditorModel(model("inmemory", "model"))).toBe(false);
  });
});
