import { describe, expect, test } from "bun:test";

import { LspClientHandover } from "./lsp-client-handover";

const frame = (message: object) => JSON.stringify({ jsonrpc: "2.0", ...message });
const parse = (text: string | null) => (text === null ? null : (JSON.parse(text) as unknown));

const CAPABILITIES = { capabilities: { hoverProvider: true } };
const URI = "file:///wt/a.ts";

/** A handover through a first client's handshake, with one document open. */
function initialized(): LspClientHandover {
  const handover = new LspClientHandover();
  handover.fromClient(frame({ id: 0, method: "initialize", params: {} }));
  handover.fromServer(frame({ id: 0, result: CAPABILITIES }));
  handover.fromClient(frame({ method: "initialized", params: {} }));
  handover.fromClient(
    frame({ method: "textDocument/didOpen", params: { textDocument: { uri: URI, text: "" } } }),
  );
  return handover;
}

describe("LspClientHandover", () => {
  test("passes a first client's frames through unchanged", () => {
    const handover = new LspClientHandover();
    const request = frame({ id: 3, method: "textDocument/hover", params: {} });
    expect(handover.fromClient(request)).toEqual({ toServer: request, toClient: [] });
    const answer = frame({ id: 3, result: null });
    expect(handover.fromServer(answer)).toEqual({ toClient: answer, toServer: [] });
  });

  test("can hand over only once the client finished its handshake", () => {
    const handover = new LspClientHandover();
    handover.fromClient(frame({ id: 0, method: "initialize", params: {} }));
    expect(handover.canAdopt).toBe(false);
    handover.fromServer(frame({ id: 0, result: CAPABILITIES }));
    expect(handover.canAdopt).toBe(false);
    handover.fromClient(frame({ method: "initialized", params: {} }));
    expect(handover.canAdopt).toBe(true);
  });

  test("a client that goes cancels its requests and closes its documents", () => {
    const handover = initialized();
    handover.fromClient(frame({ id: 7, method: "textDocument/hover", params: {} }));

    const { toServer, didClose } = handover.disconnect();
    expect(toServer.map(parse)).toEqual([
      { jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 7 } },
    ]);
    expect(didClose.map(parse)).toEqual([
      { jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri: URI } } },
    ]);
  });

  test("answers the server's requests while no client is connected", () => {
    const handover = initialized();
    handover.fromServer(frame({ id: 1, method: "workspace/applyEdit", params: {} }));

    // Asked before the client went, and while it is gone.
    const { toServer } = handover.disconnect();
    expect(toServer.map(parse)).toEqual([
      { jsonrpc: "2.0", id: 1, error: { code: -32800, message: "No client is connected" } },
    ]);
    const registration = { id: "r1", method: "textDocument/formatting" };
    const asked = handover.fromServer(
      frame({
        id: 2,
        method: "client/registerCapability",
        params: { registrations: [registration] },
      }),
    );
    expect(asked.toClient).toBeNull();
    expect(asked.toServer.map(parse)).toEqual([{ jsonrpc: "2.0", id: 2, result: null }]);
    expect(handover.fromServer(frame({ method: "window/logMessage", params: {} })).toClient).toBe(
      null,
    );
  });

  test("an adopting client gets the first handshake's answer and the registrations", () => {
    const handover = initialized();
    const registration = { id: "r1", method: "textDocument/formatting" };
    handover.fromServer(
      frame({
        id: 1,
        method: "client/registerCapability",
        params: { registrations: [registration] },
      }),
    );
    handover.fromClient(frame({ id: 1, result: null }));
    handover.disconnect();
    handover.adopt();

    const init = handover.fromClient(frame({ id: 0, method: "initialize", params: {} }));
    expect(init.toServer).toBeNull();
    expect(init.toClient.map(parse)).toEqual([{ jsonrpc: "2.0", id: 0, result: CAPABILITIES }]);

    const done = handover.fromClient(frame({ method: "initialized", params: {} }));
    expect(done.toServer).toBeNull();
    expect(done.toClient.map(parse)).toEqual([
      {
        jsonrpc: "2.0",
        id: "loxel-handover-1",
        method: "client/registerCapability",
        params: { registrations: [registration] },
      },
    ]);
    // Its answer is ours, not the server's.
    expect(handover.fromClient(frame({ id: "loxel-handover-1", result: null })).toServer).toBe(
      null,
    );
  });

  test("an unregistered capability is not handed to the next client", () => {
    const handover = initialized();
    const registration = { id: "r1", method: "textDocument/formatting" };
    handover.fromServer(
      frame({
        id: 1,
        method: "client/registerCapability",
        params: { registrations: [registration] },
      }),
    );
    handover.fromServer(
      frame({
        id: 2,
        method: "client/unregisterCapability",
        params: { unregisterations: [registration] },
      }),
    );
    handover.disconnect();
    handover.adopt();
    handover.fromClient(frame({ id: 0, method: "initialize", params: {} }));
    expect(handover.fromClient(frame({ method: "initialized", params: {} })).toClient).toEqual([]);
  });

  test("an adopting client's ids do not meet the last client's on the server", () => {
    const handover = initialized();
    handover.fromClient(frame({ id: 5, method: "textDocument/hover", params: {} }));
    handover.disconnect();
    handover.adopt();
    handover.fromClient(frame({ id: 0, method: "initialize", params: {} }));
    handover.fromClient(frame({ method: "initialized", params: {} }));

    const request = parse(
      handover.fromClient(frame({ id: 5, method: "textDocument/definition", params: {} })).toServer,
    ) as { id: number };
    expect(request.id).not.toBe(5);

    // The last client's request, answered late, goes nowhere; the new one's gets its own id back.
    expect(handover.fromServer(frame({ id: 5, result: "stale" })).toClient).toBeNull();
    expect(parse(handover.fromServer(frame({ id: request.id, result: "fresh" })).toClient)).toEqual(
      { jsonrpc: "2.0", id: 5, result: "fresh" },
    );
  });

  test("an adopting client's cancellations name the server's ids", () => {
    const handover = initialized();
    handover.disconnect();
    handover.adopt();
    handover.fromClient(frame({ id: 0, method: "initialize", params: {} }));
    handover.fromClient(frame({ method: "initialized", params: {} }));
    const request = parse(
      handover.fromClient(frame({ id: 1, method: "textDocument/hover", params: {} })).toServer,
    ) as { id: number };

    const cancel = handover.fromClient(frame({ method: "$/cancelRequest", params: { id: 1 } }));
    expect(parse(cancel.toServer)).toEqual({
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: request.id },
    });
    // One for a request already answered has nothing to cancel.
    handover.fromServer(frame({ id: request.id, result: null }));
    expect(
      handover.fromClient(frame({ method: "$/cancelRequest", params: { id: 1 } })).toServer,
    ).toBeNull();
  });
  test("an answer written in another key order maps back the same way", () => {
    const handover = initialized();
    handover.disconnect();
    handover.adopt();
    handover.fromClient(frame({ id: 0, method: "initialize", params: {} }));
    handover.fromClient(frame({ method: "initialized", params: {} }));
    const request = parse(
      handover.fromClient(frame({ id: 2, method: "textDocument/hover", params: {} })).toServer,
    ) as { id: number };

    const answer = JSON.stringify({ result: { contents: "x" }, id: request.id, jsonrpc: "2.0" });
    expect(parse(handover.fromServer(answer).toClient)).toEqual({
      result: { contents: "x" },
      id: 2,
      jsonrpc: "2.0",
    });
  });

  test("while no client is connected, answers go nowhere", () => {
    const handover = initialized();
    handover.disconnect();
    expect(handover.fromServer(frame({ id: 9, result: null })).toClient).toBeNull();
  });

  test("passes edits through without looking at them", () => {
    const handover = initialized();
    const edit = frame({
      method: "textDocument/didChange",
      params: { textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: "x" }] },
    });
    expect(handover.fromClient(edit)).toEqual({ toServer: edit, toClient: [] });
  });
});
