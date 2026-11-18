import { describe, expect, test } from "bun:test";

import * as monaco from "monaco-editor";

import { toServerId } from "@/api/worktree-ref";

import {
  editorFile,
  editorFileUri,
  isLiveEditorModel,
  markPreviewModel,
  serverAuthority,
} from "./live-editor-model";

const SERVER = toServerId("0b9f6c1e-5b1a-4c55-9a43-2f1d8f0e7a10");
const PATH = "/repo/a b/ü#1.py";

const uri = (scheme: string, authority: string, fragment = "", query = "") => ({
  scheme,
  authority,
  path: PATH,
  query,
  fragment,
});

describe("editorFileUri", () => {
  test("names the server as the authority and keeps the file's path, in both schemes", () => {
    for (const scheme of ["file", "loxel"] as const) {
      const built = editorFileUri({ server: SERVER, path: PATH }, scheme);
      expect(built.toString()).toBe(`${scheme}://${SERVER}/repo/a%20b/%C3%BC%231.py`);
      expect(built.path).toBe(PATH);
    }
  });

  test("round-trips through its text, as a language server's answer does", () => {
    for (const scheme of ["file", "loxel"] as const) {
      const text = editorFileUri({ server: SERVER, path: PATH }, scheme).toString();
      expect(editorFile(monaco.Uri.parse(text))).toEqual({ server: SERVER, path: PATH });
    }
  });

  test("refuses a server id that Monaco's printing would change", () => {
    expect(() => serverAuthority(toServerId("Upper-Case"))).toThrow("cannot be a URI authority");
    expect(() => serverAuthority(toServerId("user@host"))).toThrow("cannot be a URI authority");
  });
});

describe("editorFile", () => {
  test("is the server and path of editor tab models", () => {
    expect(editorFile(uri("file", SERVER))).toEqual({ server: SERVER, path: PATH });
    expect(editorFile(uri("loxel", SERVER))).toEqual({ server: SERVER, path: PATH });
  });

  test("is null for a URI with no server, as servers send them", () => {
    expect(editorFile(uri("file", ""))).toBeNull();
    expect(editorFile(uri("loxel", "HEAD"))).toBeNull();
    expect(editorFile(uri("loxel", "head"))).toBeNull();
    expect(editorFile(uri("file", "host:80"))).toBeNull();
  });

  test("is null for diff, history and compare sides", () => {
    expect(editorFile(uri("loxel", "HEAD", "new"))).toBeNull();
    expect(editorFile(uri("loxel", "abc123", "old"))).toBeNull();
    expect(editorFile(uri("loxel", "working-tree", "new"))).toBeNull();
    expect(editorFile(uri("loxel", "compare", "panel-1-old"))).toBeNull();
  });

  test("is null for other schemes and for URIs with a query", () => {
    expect(editorFile(uri("inmemory", "model"))).toBeNull();
    expect(editorFile(uri("untitled", ""))).toBeNull();
    expect(editorFile(uri("file", SERVER, "", "x=1"))).toBeNull();
  });
});

describe("isLiveEditorModel", () => {
  test("accepts editor tab models and rejects the rest", () => {
    expect(isLiveEditorModel({ uri: uri("file", SERVER) })).toBe(true);
    expect(isLiveEditorModel({ uri: uri("loxel", SERVER) })).toBe(true);
    expect(isLiveEditorModel({ uri: uri("file", "") })).toBe(false);
    expect(isLiveEditorModel({ uri: uri("loxel", "HEAD", "new") })).toBe(false);
    expect(isLiveEditorModel({ uri: uri("inmemory", "model") })).toBe(false);
  });

  test("rejects a peek widget's snapshot of a file", () => {
    const snapshot = { uri: uri("file", SERVER) };
    markPreviewModel(snapshot);
    expect(isLiveEditorModel(snapshot)).toBe(false);
  });
});
