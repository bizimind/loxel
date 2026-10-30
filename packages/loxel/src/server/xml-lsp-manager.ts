import path from "node:path";

import { WorktreeLspManager } from "./stdio-lsp-manager";

export class XmlLspManager extends WorktreeLspManager {
  constructor(private readonly workDir: string) {
    super("xml-lsp");
  }

  // With downloads off, LemMinX reads schemas only from its cache, which `SchemaDownloads` fills.
  protected override getInitializationOptions(): Record<string, unknown> {
    return {
      settings: {
        xml: { downloadExternalResources: { enabled: false }, server: { workDir: this.workDir } },
      },
    };
  }

  protected resolveBinary(): string | null {
    return this.resolveBundledBinary(
      "lemminx",
      path.resolve(import.meta.dir, "../../build/lemminx/lemminx"),
    );
  }
}
