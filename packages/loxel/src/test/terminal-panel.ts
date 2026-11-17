/**
 * A terminal panel's side of the app socket, for tests against a real server: what it receives
 * for the terminals it attaches to, and the messages it sends. The package's test preload replaces
 * `WebSocket` with a browser one; callers unregister it first.
 */
import { encodeInputFrame, parseOutputFrame } from "@/api/terminal-stream";
import type { WsMessage } from "@/api/ws-protocol";

type Message<T extends WsMessage["type"]> = Extract<WsMessage, { type: T }>;

/** A port nothing listens on yet. */
export function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
}

/** A panel's view of terminals over its own socket: states, sizes, output, exits and its offset. */
export async function openPanel(baseUrl: string) {
  const states: Message<"terminal_state">[] = [];
  const sizes: Message<"terminal_size">[] = [];
  const exits: Message<"terminal_exit">[] = [];
  let text = "";
  let offset: number | null = null;
  const socket = new WebSocket(baseUrl.replace("http", "ws") + "/ws");
  socket.binaryType = "arraybuffer";
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      const frame = parseOutputFrame(new Uint8Array(event.data as ArrayBuffer));
      if (!frame) return;
      text += new TextDecoder().decode(frame.payload);
      offset = frame.offset + frame.payload.byteLength;
      return;
    }
    const message = JSON.parse(event.data) as WsMessage;
    if (message.type === "terminal_exit") exits.push(message);
    if (message.type === "terminal_size") sizes.push(message);
    if (message.type !== "terminal_state") return;
    states.push(message);
    offset = message.offset;
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  const send = (message: object) => socket.send(JSON.stringify(message));
  return {
    states,
    sizes,
    exits,
    text: () => text,
    offset: () => offset,
    attach: (
      id: string,
      since?: { epoch: string; offset: number },
      size = { cols: 80, rows: 24 },
    ) =>
      send({
        type: "terminal_attach",
        id,
        ...size,
        cwd: "/tmp",
        worktreePath: "/tmp",
        ...(since && { sinceEpoch: since.epoch, sinceOffset: since.offset }),
      }),
    /** Claim the terminal at `size`, as a panel does when its user types into it. */
    claim: (id: string, size = { cols: 80, rows: 24 }) =>
      send({ type: "terminal_resize", id, ...size }),
    type: (id: string, line: string) =>
      socket.send(new Uint8Array(encodeInputFrame(id, new TextEncoder().encode(`${line}\n`)))),
    detach: (id: string) => send({ type: "terminal_detach", id }),
    destroy: (id: string) => send({ type: "terminal_destroy", id }),
    close: () => socket.close(),
  };
}
