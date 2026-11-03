import { describe, expect, test } from "bun:test";

import type { IRequestSender, ResponseObject } from "@hediet/json-rpc";
import type * as monaco from "monaco-editor";

import { api, LSPErrorCodes } from "../types";
import {
  CancellationError,
  LspCancellableRequests,
  rejectingServerCancellations,
  ServerCancellationError,
} from "./LspCancellableRequests";

/** A request sender whose every request is answered with `response`, or fails as `send` does. */
function answering(
  response: ResponseObject,
  send: IRequestSender["sendRequest"] = async () => response,
): IRequestSender {
  return {
    sendRequest: send,
    sendNotification: async () => {},
    toString: () => "fake sender",
    get state(): IRequestSender["state"] {
      throw new Error("not used");
    },
  };
}

const request = { method: "textDocument/codeLens", params: {} };

describe("rejectingServerCancellations", () => {
  test.each([
    ["RequestCancelled", LSPErrorCodes.RequestCancelled],
    ["ServerCancelled", LSPErrorCodes.ServerCancelled],
    ["ContentModified", LSPErrorCodes.ContentModified],
  ])("rejects a %s answer as a cancellation Monaco recognizes", async (_name, code) => {
    const sender = rejectingServerCancellations(
      answering({ error: { code, message: "content modified", data: { retrigger: 1 } } }),
    );

    const error = await sender.sendRequest(request, undefined).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServerCancellationError);
    expect(error).toBeInstanceOf(CancellationError);
    expect(error).toMatchObject({
      name: "Canceled",
      message: "Canceled",
      code,
      serverMessage: "content modified",
    });
    expect(error).toHaveProperty("data", { retrigger: 1 });
  });

  test("passes other errors and results through", async () => {
    const failed: ResponseObject = { error: { code: -32603, message: "internal error" } };
    const answered: ResponseObject = { result: [] };

    expect(await rejectingServerCancellations(answering(failed)).sendRequest(request)).toBe(failed);
    expect(await rejectingServerCancellations(answering(answered)).sendRequest(request)).toBe(
      answered,
    );
  });
});

describe("LspCancellableRequests", () => {
  test("passes a server's cancellation through as is", async () => {
    const cancelled = new ServerCancellationError(LSPErrorCodes.ContentModified, "modified", null);
    const sender = answering({ result: null }, () => Promise.reject(cancelled));
    const requests = new LspCancellableRequests(sender, {} as typeof api.TServerInterface);
    const token: monaco.CancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    };

    const error = await requests
      .request(api.server.workspaceSymbol, { query: "" }, token)
      .catch((e: unknown) => e);

    expect(error).toBe(cancelled);
  });
});
