import type { IRequestSender, ISerializer, RequestId } from "@hediet/json-rpc";
import { RequestHandlingError } from "@hediet/json-rpc";
import type * as monaco from "monaco-editor";

import type { api } from "../types";
import { LSPErrorCodes } from "../types";

/** The error Monaco's `isCancellationError` recognizes (name and message both "Canceled"). */
export class CancellationError extends Error {
  constructor() {
    super("Canceled");
    this.name = "Canceled";
  }
}

/** The answers by which a server says it dropped a request rather than failed it. */
const SERVER_CANCELLATION_CODES: ReadonlySet<number> = new Set([
  LSPErrorCodes.RequestCancelled,
  LSPErrorCodes.ServerCancelled,
  LSPErrorCodes.ContentModified,
]);

/**
 * A request the server cancelled: `RequestCancelled`, `ServerCancelled` (`data` may hold
 * `retriggerRequest`) or `ContentModified`, which servers such as rust-analyzer and clangd answer to
 * requests made stale by an edit. Monaco treats it as a cancelled request, not a failure to report,
 * and asks again after the edit.
 */
export class ServerCancellationError extends CancellationError {
  constructor(
    readonly code: number,
    /** The server's own message, since `message` must stay "Canceled" for Monaco. */
    readonly serverMessage: string,
    readonly data: unknown,
  ) {
    super();
  }
}

/**
 * `sender`, rejecting with a `ServerCancellationError` where the server answered that it cancelled
 * the request, so every request made through the client gets it instead of a failure.
 */
export function rejectingServerCancellations<TContext>(
  sender: IRequestSender<TContext>,
): IRequestSender<TContext> {
  return {
    async sendRequest(request, context, messageIdCallback) {
      const response = await sender.sendRequest(request, context, messageIdCallback);
      if (!("error" in response) || !response.error) return response;
      const code = Number(response.error.code);
      if (SERVER_CANCELLATION_CODES.has(code)) {
        throw new ServerCancellationError(code, response.error.message, response.error.data);
      }
      return response;
    },
    sendNotification: (notification, context) => sender.sendNotification(notification, context),
    toString: () => sender.toString(),
    get state() {
      return sender.state;
    },
  };
}

/** `promise`, or a `CancellationError` as soon as `token` is cancelled. */
export function untilCancelled<T>(
  promise: Promise<T>,
  token: monaco.CancellationToken,
): Promise<T> {
  if (token.isCancellationRequested) return Promise.reject(new CancellationError());
  return new Promise<T>((resolve, reject) => {
    const cancellation = token.onCancellationRequested(() => {
      cancellation.dispose();
      reject(new CancellationError());
    });
    promise.then(
      (value) => {
        cancellation.dispose();
        resolve(value);
      },
      (error: unknown) => {
        cancellation.dispose();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
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
          if (error instanceof ServerCancellationError) {
            reject(error);
            return;
          }
          reject(new Error(`${type.method}: request could not be sent`, { cause: error }));
        },
      );
    });
  }
}
