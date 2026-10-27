import path from "node:path";

import { WorktreeLspManager } from "./stdio-lsp-manager";

export class XmlLspManager extends WorktreeLspManager {
  constructor() {
    super("xml-lsp");
  }

  protected resolveBinary(): string | null {
    return this.resolveBundledBinary(
      "lemminx",
      path.resolve(import.meta.dir, "../../build/lemminx/lemminx"),
    );
  }
}
