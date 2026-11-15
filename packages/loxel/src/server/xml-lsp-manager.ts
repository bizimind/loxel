import path from "node:path";

import { WorktreeLspManager, type WtLspSession } from "./stdio-lsp-manager";

/**
 * LemMinX's download setting covers what it reads through its cache. Everything else it would open
 * goes through the JVM's URL handlers, so those get a proxy that leads nowhere, for every host.
 */
const NO_OUTBOUND_ARGS = [
  ...["http", "https", "ftp"].flatMap((protocol) => [
    `-D${protocol}.proxyHost=127.0.0.1`,
    `-D${protocol}.proxyPort=9`,
    `-D${protocol}.nonProxyHosts=`,
  ]),
  "-DsocksProxyHost=127.0.0.1",
  "-DsocksProxyPort=9",
];

export class XmlLspManager extends WorktreeLspManager {
  constructor(private readonly workDir: string) {
    super("xml-lsp");
  }

  protected override spawnArgs(): readonly string[] {
    return [...NO_OUTBOUND_ARGS, "--stdio"];
  }

  // LemMinX offers to download a schema anyway, which only `SchemaConsent` may decide.
  protected override handleServerFrame(session: WtLspSession, body: string): void {
    super.handleServerFrame(session, withoutForceDownload(body));
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

/** The frame without the "Force download" quick fixes in a code action response. */
export function withoutForceDownload(body: string): string {
  if (!body.includes("Force download")) return body;
  const message = JSON.parse(body) as { result?: unknown };
  if (!Array.isArray(message.result)) return body;
  const result = message.result.filter(
    (action: { title?: unknown }) =>
      typeof action.title !== "string" || !action.title.startsWith("Force download"),
  );
  return JSON.stringify({ ...message, result });
}
