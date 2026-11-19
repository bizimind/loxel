import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { until } from "@/test/until";

import { WsClient } from "./client";
import { localRef, localServerId } from "./local-server";
import { toServerId, worktreeRef } from "./worktree-ref";
import type { WsClientMessage, WsMessage } from "./ws-protocol";

/** A WebSocket the test opens, feeds and closes by hand. */
class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: WsClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as WsClientMessage);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receive(message: WsMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const realWebSocket = globalThis.WebSocket;
const hello = (
  bootEpoch = "boot-1",
  version = "1.0.0",
  serverId: string = localServerId(),
): WsMessage => ({ type: "server_hello", version, serverId, bootEpoch });
const lastSocket = (): FakeSocket => {
  const socket = FakeSocket.instances.at(-1);
  if (!socket) throw new Error("no socket");
  return socket;
};

/** What `GET /api/session` answers: the server accepts the window's session unless set to 401. */
let sessionStatus = 204;
/** How many times the client asked. */
let sessionChecks = 0;

beforeAll(() => {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  // postLogEntry reports to the server; there is none here.
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request) => {
        if (String(input) !== "/api/session") return new Response();
        sessionChecks++;
        return new Response(null, { status: sessionStatus });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
});

afterAll(() => {
  globalThis.WebSocket = realWebSocket;
});

beforeEach(() => {
  FakeSocket.instances = [];
  sessionStatus = 204;
  sessionChecks = 0;
});

/** A client connected to its first server, with its socket. */
function connected(): { client: WsClient; socket: FakeSocket } {
  const client = new WsClient();
  client.attach(localServerId(), "");
  client.connect();
  const socket = lastSocket();
  socket.open();
  socket.receive(hello());
  return { client, socket };
}

/** Drop the client's socket and bring a new one up to its open state (before the hello). */
function dropAndReopen(client: WsClient): FakeSocket {
  lastSocket().close();
  client.retryNow();
  const socket = lastSocket();
  socket.open();
  return socket;
}

describe("WsClient", () => {
  test("sends nothing before the server's hello, then the worktrees and what was queued", () => {
    const client = new WsClient();
    client.attach(localServerId(), "");
    client.subscribeWorktree(localRef("/wt"));
    client.send({ type: "window_hello", windowId: "w1" });
    client.connect();
    const socket = lastSocket();
    socket.open();
    expect(socket.sent).toEqual([]);
    expect(client.getConnectionState()).toBe("connecting");

    socket.receive(hello());

    expect(socket.sent).toEqual([
      { type: "subscribe_worktree", worktreePath: "/wt" },
      { type: "window_hello", windowId: "w1" },
    ]);
    expect(client.getConnectionState()).toBe("connected");
  });

  test("after a reconnect, re-subscribes every worktree with the shown one last", () => {
    const { client } = connected();
    client.subscribeWorktree(localRef("/a"));
    client.subscribeWorktree(localRef("/b"));
    // Back to /a while /b still drains its saves: /a is shown again.
    client.subscribeWorktree(localRef("/a"));
    client.subscribeWorktree(localRef("/c"));
    client.unsubscribeWorktree(localRef("/c"));

    const socket = dropAndReopen(client);
    socket.receive(hello());

    expect(socket.sent).toEqual([
      { type: "subscribe_worktree", worktreePath: "/b" },
      { type: "subscribe_worktree", worktreePath: "/a" },
    ]);
  });

  test("runs the reconnect listeners, then sends only what the user asked for meanwhile", () => {
    const { client } = connected();
    const order: string[] = [];
    client.onReconnect(() => order.push("listener"));
    lastSocket().close();
    expect(client.getConnectionState()).toBe("reconnecting");
    client.send({ type: "terminal_resize", id: "t1", cols: 80, rows: 24 });
    client.send({ type: "terminal_destroy", id: "t2" });
    client.send({ type: "notification_dismiss", id: "n1" });

    client.retryNow();
    const socket = lastSocket();
    socket.open();
    const send = socket.send.bind(socket);
    socket.send = (data: string) => {
      order.push("send");
      send(data);
    };
    socket.receive(hello());

    expect(order).toEqual(["listener", "send", "send"]);
    expect(socket.sent).toEqual([
      { type: "terminal_destroy", id: "t2" },
      { type: "notification_dismiss", id: "n1" },
    ]);
    expect(client.getConnectionState()).toBe("connected");
  });

  test("runs the reconnect listeners after a reconnect, whether the server restarted or not", () => {
    const { client } = connected();
    let reconnects = 0;
    client.onReconnect(() => reconnects++);

    dropAndReopen(client).receive(hello("boot-1"));
    dropAndReopen(client).receive(hello("boot-2"));

    expect(reconnects).toBe(2);
  });

  test("reloads instead of resyncing when a new version of the server answers", () => {
    const reload = mock(() => {});
    spyOn(window.location, "reload").mockImplementation(reload);
    const { client } = connected();
    const listener = mock(() => {});
    client.onReconnect(listener);

    dropAndReopen(client).receive(hello("boot-2", "1.0.1"));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
  });

  test("reloads when the server is not the one the window started with", () => {
    const reload = mock(() => {});
    spyOn(window.location, "reload").mockImplementation(reload);
    const client = new WsClient();
    client.attach(localServerId(), "");
    client.connect();
    lastSocket().open();

    lastSocket().receive(hello("boot-1", "1.0.0", "another-server"));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("ignores a socket it already replaced", () => {
    // React's StrictMode runs the bridge's effect twice: connect, disconnect, connect.
    const client = new WsClient();
    client.attach(localServerId(), "");
    client.connect();
    const stale = lastSocket();
    client.disconnect();
    client.connect();
    const current = lastSocket();

    stale.open();
    stale.receive(hello());
    stale.onclose?.();
    client.retryNow();

    expect(FakeSocket.instances).toEqual([stale, current]);
    expect(client.getConnectionState()).toBe("connecting");
    current.open();
    current.receive(hello());
    expect(client.getConnectionState()).toBe("connected");
  });

  test("a socket that never got a hello is retried while the server accepts the window", async () => {
    const client = new WsClient();
    client.attach(localServerId(), "");
    client.connect();
    lastSocket().close();

    await until(() => sessionChecks === 1);
    // The retry waits out the backoff; retryNow runs it now, which it can only once one is set.
    await until(() => {
      client.retryNow();
      return FakeSocket.instances.length === 2;
    });
    expect(client.getConnectionState()).toBe("connecting");
  });

  test("expires, and stops retrying, when the server no longer accepts the window", async () => {
    const { client } = connected();
    sessionStatus = 401;
    lastSocket().close();
    expect(sessionChecks).toBe(0);
    client.retryNow();
    lastSocket().close();

    await until(() => client.getConnectionState() === "expired");
    client.retryNow();
    expect(FakeSocket.instances).toHaveLength(2);
  });

  test("expires at once when told, closing its socket", () => {
    const { client, socket } = connected();
    client.expireSession();
    expect(client.getConnectionState()).toBe("expired");
    expect(socket.readyState).toBe(3);
    client.retryNow();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test("reports each state change to its subscribers", () => {
    const { client } = connected();
    const states: string[] = [];
    client.onConnectionStateChange(() => states.push(client.getConnectionState()));

    dropAndReopen(client).receive(hello());

    expect(states).toEqual(["reconnecting", "connected"]);
  });
});

describe("WsClient.whenSubscribed", () => {
  /** Whether the promise has settled, once the microtasks queued so far have run. */
  async function settled(promise: Promise<void>): Promise<boolean> {
    let done = false;
    void promise.then(() => {
      done = true;
    });
    await Promise.resolve();
    return done;
  }

  test("waits for the server to confirm a new subscription", async () => {
    const { client, socket } = connected();
    client.subscribeWorktree(localRef("/wt"));
    const waiting = client.whenSubscribed(localRef("/wt"));
    expect(await settled(waiting)).toBe(false);

    socket.receive({ type: "worktree_files_resynced", wtPath: "/wt", projectPath: "/" });

    expect(await settled(waiting)).toBe(true);
    expect(await settled(client.whenSubscribed(localRef("/wt")))).toBe(true);
  });

  test("waits again after a reconnect, which may be to a restarted server", async () => {
    const { client, socket } = connected();
    client.subscribeWorktree(localRef("/wt"));
    socket.receive({ type: "worktree_files_resynced", wtPath: "/wt", projectPath: "/" });

    const reopened = dropAndReopen(client);
    reopened.receive(hello("boot-2"));
    const waiting = client.whenSubscribed(localRef("/wt"));
    expect(await settled(waiting)).toBe(false);

    reopened.receive({ type: "worktree_files_resynced", wtPath: "/wt", projectPath: "/" });
    expect(await settled(waiting)).toBe(true);
  });

  test("refuses a worktree of another server, even at a path it is subscribed to", async () => {
    const { client, socket } = connected();
    client.subscribeWorktree(localRef("/wt"));
    const elsewhere = worktreeRef(toServerId("other-server"), "/wt");

    expect(() => client.subscribeWorktree(elsewhere)).toThrow("Not a worktree");
    expect(() => client.unsubscribeWorktree(elsewhere)).toThrow("Not a worktree");
    expect(socket.sent).toEqual([{ type: "subscribe_worktree", worktreePath: "/wt" }]);
    expect(await settled(client.whenSubscribed(localRef("/wt")))).toBe(false);
  });

  test("does not wait for a worktree the window is not subscribed to", async () => {
    const { client } = connected();
    expect(await settled(client.whenSubscribed(localRef("/other")))).toBe(true);
  });

  test("stops waiting when the subscription ends", async () => {
    const { client } = connected();
    client.subscribeWorktree(localRef("/left"));
    const left = client.whenSubscribed(localRef("/left"));

    client.unsubscribeWorktree(localRef("/left"));
    expect(await settled(left)).toBe(true);
  });

  test("a refused subscription stops only its own worktree's wait", async () => {
    const { client, socket } = connected();
    client.subscribeWorktree(localRef("/refused"));
    client.subscribeWorktree(localRef("/shown"));
    const refused = client.whenSubscribed(localRef("/refused"));
    const shown = client.whenSubscribed(localRef("/shown"));

    socket.receive({ type: "error", message: "No project found", wtPath: "/refused" });
    expect(await settled(refused)).toBe(true);
    // Nothing will confirm it now: later reads go out at once, to fail as they did before.
    expect(await settled(client.whenSubscribed(localRef("/refused")))).toBe(true);
    // The other subscription is still being answered, and an error naming no worktree is not one.
    socket.receive({ type: "error", message: "Something else" });
    expect(await settled(shown)).toBe(false);

    socket.receive({ type: "worktree_files_resynced", wtPath: "/shown", projectPath: "/" });
    expect(await settled(shown)).toBe(true);
  });
});
