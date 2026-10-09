import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ChannelClient } from "../src/client.ts";

interface RelayHarness {
  url: string;
  /** Token query parameter seen on each WebSocket upgrade, in order */
  upgradeTokens: (string | null)[];
  /** Close the most recently joined socket from the server side */
  dropLatest: () => void;
  stop: () => void;
}

interface SocketData {
  token: string | null;
}

/** Minimal relay stand-in: records the upgrade token and answers `join` with `joined`. */
function startRelay(): RelayHarness {
  const upgradeTokens: (string | null)[] = [];
  let latest: Bun.ServerWebSocket<SocketData> | null = null;

  const server = Bun.serve<SocketData>({
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      const token = url.searchParams.get("token");
      upgradeTokens.push(token);
      if (server.upgrade(request, { data: { token } })) {
        return undefined;
      }
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        if (typeof raw !== "string") return;
        const envelope = JSON.parse(raw) as { type: string };
        if (envelope.type !== "join") return;
        latest = ws;
        ws.send(
          JSON.stringify({
            type: "joined",
            ts: Date.now(),
            payload: { clientId: `client-${upgradeTokens.length}`, channelId: "room", peers: [] },
          }),
        );
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}`,
    upgradeTokens,
    dropLatest: () => latest?.close(1012, "restart"),
    stop: () => server.stop(true),
  };
}

describe("ChannelClient WebSocket URL", () => {
  let relay: RelayHarness;
  let client: ChannelClient | null = null;

  beforeEach(() => {
    relay = startRelay();
  });

  afterEach(() => {
    client?.disconnect();
    client = null;
    relay.stop();
  });

  test("sends the token as a query parameter on the upgrade request", async () => {
    client = new ChannelClient({
      url: `${relay.url}/`,
      channelId: "room",
      token: "jwt one/two",
      autoReconnect: false,
    });

    await client.connect();

    expect(relay.upgradeTokens).toEqual(["jwt one/two"]);
  });

  test("uses the token from setToken() on auto-reconnect", async () => {
    client = new ChannelClient({
      url: relay.url,
      channelId: "room",
      token: "first",
      reconnectBaseDelay: 10,
      reconnectMaxDelay: 10,
    });

    await client.connect();
    client.setToken("second");

    const reconnected = new Promise<void>((resolve) => {
      client?.on("connected", () => resolve());
    });
    relay.dropLatest();
    await reconnected;

    expect(relay.upgradeTokens).toEqual(["first", "second"]);
  });
});
