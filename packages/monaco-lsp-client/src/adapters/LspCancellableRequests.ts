import type { IRequestSender, ISerializer, RequestId } from "@hediet/json-rpc";
import { RequestHandlingError } from "@hediet/json-rpc";
import type * as monaco from "monaco-editor";

import type { api } from "../types";

/** The error Monaco's `isCancellationError` recognizes (name and message both "Canceled"). */
export class CancellationError extends Error {
  constructor() {
    super("Canceled");
    this.name = "Canceled";
  }
}

interface CancellableRequestType<TParams, TResult> {
  method: string;
  paramsSerializer: ISerializer<TParams>;
  resultSerializer: ISerializer<TResult>;
}

/**
 * Sends requests that a Monaco cancellation token can cancel. `TypedChannel.request` does not
 * expose the JSON-RPC id that `$/cancelRequest` must name, so these requests go to the channel's
 * request sender directly, which reports the id. Cancelling sends `$/cancelRequest` and rejects
 * at once with a `CancellationError`; the server's late answer is dropped.
 */
export class LspCancellableRequests {
  constructor(
    private readonly _sender: IRequestSender,
    private readonly _server: typeof api.TServerInterface,
  ) {}

  request<TParams, TResult>(
    type: CancellableRequestType<TParams, TResult>,
    params: TParams,
    token: monaco.CancellationToken,
  ): Promise<TResult> {
    if (token.isCancellationRequested) return Promise.reject(new CancellationError());

    const json = type.paramsSerializer.serializeToJson(params);
    if (json === null || typeof json !== "object") {
      return Promise.reject(new Error(`${type.method}: params must be an object or an array`));
    }

    let requestId: RequestId | undefined;
    const response = this._sender.sendRequest(
      { method: type.method, params: json },
      undefined,
      (id) => {
        requestId = id;
      },
    );

    return new Promise<TResult>((resolve, reject) => {
      const cancellation = token.onCancellationRequested(() => {
        cancellation.dispose();
        if (requestId !== undefined) this._server.cancelRequest({ id: requestId });
        reject(new CancellationError());
      });

      response.then(
        (r) => {
          cancellation.dispose();
          if ("error" in r) {
            reject(new RequestHandlingError(r.error.message, r.error.data, r.error.code));
            return;
          }
          const result = type.resultSerializer.deserializeFromJson(r.result);
          if (result.hasErrors) {
            reject(
              new Error(`${type.method}: could not deserialize response: ${result.errorMessage}`),
            );
            return;
          }
          resolve(result.value);
        },
        (error: unknown) => {
          cancellation.dispose();
          reject(new Error(`${type.method}: request could not be sent`, { cause: error }));
        },
      );
    });
  }
}
