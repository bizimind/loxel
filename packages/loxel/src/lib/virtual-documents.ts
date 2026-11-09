import type { MonacoLspClient } from "@bizimind/monaco-lsp-client";
import type * as monaco from "monaco-editor";

import { frontendLog } from "./frontend-logger";
import { isRecord } from "./is-record";

const log = frontendLog.child("ui");

/** How a language's client module exposes its server's read-only documents. */
export interface VirtualDocumentOptions {
  /** The URI scheme of the server's documents. */
  scheme: string;
  /**
   * The text of the document at `uri`, from this server: its definition ranges must match the text
   * shown. Defaults to LSP's standard `workspace/textDocumentContent`.
   */
  read?: (
    client: Pick<MonacoLspClient, "request">,
    uri: string,
    token: monaco.CancellationToken,
  ) => Promise<string>;
}

/** A live connection to the server behind a scheme. Its documents last as long as it does. */
export interface VirtualDocumentConnection {
  /** Differs for every connection, so a tab restored later can tell it is not its own. */
  readonly id: string;
  readonly languageId: string;
  read(uri: string, token: monaco.CancellationToken): Promise<string>;
  /** `listener` runs once when the connection ends. */
  onDidClose(listener: () => void): monaco.IDisposable;
}

/** Message of an editor showing one of these documents. */
export const VIRTUAL_DOCUMENT_READ_ONLY_MESSAGE =
  "This source comes from the language server and is read-only.";

/** Every scheme a client registered, with its live connection if any. */
const connections = new Map<string, VirtualDocumentConnection | null>();

function schemeOf(uri: string): string {
  return uri.slice(0, Math.max(0, uri.indexOf(":")));
}

async function readTextDocumentContent(
  client: Pick<MonacoLspClient, "request">,
  uri: string,
  token: monaco.CancellationToken,
): Promise<string> {
  const result = await client.request("workspace/textDocumentContent", { uri }, token);
  if (!isRecord(result) || typeof result.text !== "string") {
    throw new TypeError("The server's answer has no text");
  }
  return result.text;
}

/**
 * Registers a language client's scheme. `connected` starts a connection for each of its clients
 * and returns what ends it.
 */
export function registerVirtualDocumentScheme(
  { scheme, read = readTextDocumentContent }: VirtualDocumentOptions,
  languageId: string,
): { connected(client: Pick<MonacoLspClient, "request">): () => void } {
  connections.set(scheme, null);
  return {
    connected(client) {
      const listeners = new Set<() => void>();
      const connection: VirtualDocumentConnection = {
        id: crypto.randomUUID(),
        languageId,
        read: (uri, token) => read(client, uri, token),
        onDidClose(listener) {
          listeners.add(listener);
          return { dispose: () => listeners.delete(listener) };
        },
      };
      connections.set(scheme, connection);
      return () => {
        if (connections.get(scheme) === connection) connections.set(scheme, null);
        // One that fails must not keep the others, or the socket's teardown after this, from running.
        for (const listener of listeners) {
          try {
            listener();
          } catch (error) {
            log.error("Closing a read-only document failed", { error });
          }
        }
      };
    },
  };
}

/** Whether a language client serves documents of `uri`'s scheme. */
export function isVirtualDocumentUri(uri: string): boolean {
  return connections.has(schemeOf(uri));
}

/** The live connection serving `uri`'s scheme, or null when there is none now. */
export function virtualDocumentConnection(uri: string): VirtualDocumentConnection | null {
  return connections.get(schemeOf(uri)) ?? null;
}

/** Every scheme a language client registered. */
export function virtualDocumentSchemes(): string[] {
  return [...connections.keys()];
}

/** The decoded path of `uri`, which for most servers says where the document came from. */
export function virtualDocumentPath(uri: string): string {
  const afterScheme = uri.slice(uri.indexOf(":") + 1).replace(/^\/\/[^/]*/, "");
  return decodeURIComponent(afterScheme.split(/[?#]/, 1)[0] ?? afterScheme).replace(/^\//, "");
}

/** The last segment of `uri`'s path, for an icon. */
export function virtualDocumentFileName(uri: string): string {
  const path = virtualDocumentPath(uri);
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A tab's title: the file name without its extension, which for most servers is the class. */
export function virtualDocumentTitle(uri: string): string {
  const name = virtualDocumentFileName(uri);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
