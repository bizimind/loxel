import { api } from "../../types";
import { Disposable } from "../../utils";
import { LspConnection } from "../LspConnection";

/** Answers the server's `workspace/applyEdit` requests through the client's workspace-edit path. */
export class LspApplyEditFeature extends Disposable {
  constructor(private readonly _connection: LspConnection) {
    super();

    this._register(
      this._connection.capabilities.addStaticClientCapabilities({ workspace: { applyEdit: true } }),
    );

    this._register(
      this._connection.connection.registerRequestHandler(
        api.client.workspaceApplyEdit,
        async (params) => {
          // The summary is for the user; the server's answer has no such field.
          const { applied, failureReason, failedChange } = await this._connection.edits.apply(
            params.edit,
          );
          return { ok: { applied, failureReason, failedChange } };
        },
      ),
    );
  }
}
