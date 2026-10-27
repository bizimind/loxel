import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import * as monaco from "monaco-editor";

import { fileUri } from "./lsp-file-uri";

describe("fileUri", () => {
  test("encodes a path exactly as Monaco's Uri.toString() does", () => {
    for (const path of [
      "/repo/src/a.ts",
      "/my wt #1 50% ü/b.py",
      "/x/c++ (1)@a/it's;a=b!$&*,~.ts",
      "/a:b/[x]{y}/?.toml",
    ]) {
      const uri = fileUri(path);
      expect(uri).toBe(monaco.Uri.file(path).toString());
      expect(fileURLToPath(uri)).toBe(path);
    }
  });
});
