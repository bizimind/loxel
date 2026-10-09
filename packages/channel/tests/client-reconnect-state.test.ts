import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ChannelClient } from "../src/client.ts";
import { ChannelError, InvalidStateError } from "../src/errors.ts";

interface RelayHarness {
  url: string;
  /** Number of WebSocket upgrades accepted so far */
  upgrades: number;
  /** When true, `join` is answered with a fatal error and a 1008 close */
  rejectJoins: boolean;
  stop: () => void;
}

/** Minimal relay stand-in that either joins the client or rejects the join as fatal. */
function startRelay(): RelayHarness {
  const harness: RelayHarness = { url: "", upgrades: 0, rejectJoins: false, stop: () => {} };

  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      harness.upgrades++;
      if (server.upgrade(request)) {
        return undefined;
      }
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        if (typeof raw !== "string") return;
        const envelope = JSON.parse(raw) as { type: string };
        if (envelope.type !== "join") return;

        if (harness.rejectJoins) {
          ws.send(
            JSON.stringify({
              type: "error",
              ts: Date.now(),
              payload: {
                code: "auth_failed",
                message: "Channel belongs to a different user",
                fatal: true,
              },
            }),
          );
          ws.close(1008, "Channel belongs to a different user");
          return;
        }

        ws.send(
          JSON.stringify({
            type: "joined",
            ts: Date.now(),
            payload: { clientId: `client-${harness.upgrades}`, channelId: "room", peers: [] },
          }),
        );
      },
    },
  });

  harness.url = `ws://127.0.0.1:${server.port}`;
  harness.stop = () => server.stop(true);
  return harness;
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        reject(new Error("timed out waiting"));
      } else {
        setTimeout(tick, 5);
      }
    };
    tick();
  });
}

describe("ChannelClient connection state", () => {
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

  test("connect() throws InvalidStateError while connected", async () => {
    client = new ChannelClient({ url: relay.url, channelId: "room", token: "jwt" });
    await client.connect();

    expect(client.state).toBe("connected");
    await expect(client.connect()).rejects.toBeInstanceOf(InvalidStateError);
  });

  test("a drop with auto-reconnect pending reports the reconnecting state", async () => {
    client = new ChannelClient({
      url: relay.url,
      channelId: "room",
      token: "jwt",
      reconnectBaseDelay: 60_000,
      reconnectMaxDelay: 60_000,
    });
    await client.connect();

    const disconnected = new Promise<boolean>((resolve) => {
      client?.on("disconnected", (event) => resolve(event.willReconnect));
    });
    relay.rejectJoins = true;
    relay.stop();

    expect(await disconnected).toBe(true);
    expect(client.state).toBe("reconnecting");
    expect(client.isConnected).toBe(false);
  });

  test("a fatal join error leaves the client reconnecting and connect() can still be called", async () => {
    relay.rejectJoins = true;
    client = new ChannelClient({
      url: relay.url,
      channelId: "room",
      token: "jwt",
      reconnectBaseDelay: 50,
      reconnectMaxDelay: 50,
    });

    await expect(client.connect()).rejects.toBeInstanceOf(ChannelError);
    await waitFor(() => client?.state === "reconnecting");
    expect(relay.upgrades).toBe(1);

    // connect() cancels the pending retry and opens exactly one new socket
    relay.rejectJoins = false;
    const connected = await client.connect();

    expect(connected.channelId).toBe("room");
    expect(client.state).toBe("connected");
    expect(relay.upgrades).toBe(2);

    // The cancelled retry timer (due in 50-62ms) must not open a third socket
    await Bun.sleep(300);
    expect(relay.upgrades).toBe(2);
  });

  test("disconnect() while reconnecting returns to disconnected without a retry", async () => {
    relay.rejectJoins = true;
    client = new ChannelClient({
      url: relay.url,
      channelId: "room",
      token: "jwt",
      reconnectBaseDelay: 10,
      reconnectMaxDelay: 10,
    });

    await expect(client.connect()).rejects.toBeInstanceOf(ChannelError);
    await waitFor(() => client?.state === "reconnecting");
    client.disconnect();

    expect(client.state).toBe("disconnected");
    const upgradesAfterDisconnect = relay.upgrades;
    await Bun.sleep(50);
    expect(relay.upgrades).toBe(upgradesAfterDisconnect);
  });
});
