import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { WsClient } from "@/api/client";
import { localRef } from "@/api/local-server";
import { registerConnection, ServerConnection } from "@/api/server-connection";
import { toServerId, worktreeRef } from "@/api/worktree-ref";
import { until } from "@/test/until";

/** A socket that never opens: the test only looks at where each one was opened. */
class FakeSocket extends EventTarget {
  static urls: string[] = [];
  constructor(readonly url: string) {
    super();
    FakeSocket.urls.push(url);
  }
  close(): void {
    this.dispatchEvent(new Event("close"));
  }
}

const OTHER = toServerId("other-server");
const UNKNOWN = toServerId("unknown-server");
const realWebSocket = globalThis.WebSocket;
let unregister: () => void = () => {};

beforeAll(() => {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  unregister = registerConnection(
    new ServerConnection({ server: OTHER, baseUrl: "/peers/other-server", ws: new WsClient() }),
  );
});

afterAll(() => {
  globalThis.WebSocket = realWebSocket;
  unregister();
});

const { createLspClient } = await import("./lsp-client");
const client = createLspClient({ route: "ws/test-lsp", name: "Test", languageId: "plaintext" });

afterEach(() => {
  client.disconnect();
  FakeSocket.urls = [];
});

/** The path and query of each socket opened, without the window's origin. */
const opened = () => FakeSocket.urls.map((url) => url.replace(/^wss?:\/\/[^/]*/, ""));

describe("a language-server client", () => {
  test("opens its socket on the connection of the worktree's server", async () => {
    client.connect(worktreeRef(OTHER, "/repo"));
    await until(() => FakeSocket.urls.length === 1);
    client.disconnect();
    client.connect(localRef("/repo"));
    await until(() => FakeSocket.urls.length === 2);
    expect(opened()).toEqual([
      "/peers/other-server/ws/test-lsp?wt=%2Frepo",
      "/ws/test-lsp?wt=%2Frepo",
    ]);
  });

  test("opens no socket for a worktree of a server without a connection", async () => {
    client.connect(worktreeRef(UNKNOWN, "/repo"));
    // Then one that can be reached, so the test waits on a socket that is opened.
    client.disconnect();
    client.connect(localRef("/repo"));
    await until(() => FakeSocket.urls.length === 1);
    expect(opened()).toEqual(["/ws/test-lsp?wt=%2Frepo"]);
  });
});
