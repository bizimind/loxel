import * as monaco from "monaco-editor";

import type { Command } from "../types";
import { api, capabilities } from "../types";
import { Disposable } from "../utils";
import type { ILspCapabilitiesRegistry } from "./LspCapabilitiesRegistry";

let nextMonacoCommandId = 0;

/**
 * Runs the server's own commands through `workspace/executeCommand`.
 *
 * A `Command` attached to a code action, code lens, completion or inlay hint is
 * either a server command (listed in `executeCommandProvider.commands`) or a
 * client command such as `editor.action.triggerSuggest`. Server commands reach
 * Monaco as one command id per client whose handler sends them back to this
 * client's server, so two clients advertising the same command name never
 * collide in Monaco's global command registry. Client commands pass through
 * unchanged.
 */
export class LspServerCommands extends Disposable {
  private readonly _registeredCommands = new Set<readonly string[]>();
  private readonly _monacoCommandId = `monaco-lsp-client.executeCommand.${nextMonacoCommandId++}`;

  constructor(
    private readonly _server: typeof api.TServerInterface,
    capabilitiesRegistry: ILspCapabilitiesRegistry,
  ) {
    super();

    this._register(
      capabilitiesRegistry.addStaticClientCapabilities({
        workspace: { executeCommand: { dynamicRegistration: true } },
      }),
    );

    this._register(
      capabilitiesRegistry.registerCapabilityHandler(
        capabilities.workspaceExecuteCommand,
        true,
        (options) => {
          const commands = options.commands;
          this._registeredCommands.add(commands);
          return { dispose: () => this._registeredCommands.delete(commands) };
        },
      ),
    );

    this._register(
      monaco.editor.registerCommand(this._monacoCommandId, (_accessor, command: unknown) => {
        if (!isCommand(command)) {
          throw new Error(`${this._monacoCommandId} expects an LSP Command argument`);
        }
        // Monaco commands are global: another server could hand out this id.
        if (!this._isServerCommand(command.command)) {
          throw new Error(`${command.command} is not a command of this language server`);
        }
        return this._execute(command);
      }),
    );
  }

  toMonacoCommand(command: Command | undefined): monaco.languages.Command | undefined {
    if (!command) return undefined;
    if (!this._isServerCommand(command.command)) {
      return { id: command.command, title: command.title, arguments: command.arguments };
    }
    return { id: this._monacoCommandId, title: command.title, arguments: [command] };
  }

  private _isServerCommand(name: string): boolean {
    for (const commands of this._registeredCommands) {
      if (commands.includes(name)) return true;
    }
    return false;
  }

  private async _execute(command: Command): Promise<void> {
    try {
      await this._server.workspaceExecuteCommand({
        command: command.command,
        arguments: command.arguments,
      });
    } catch (error) {
      console.error(`[MonacoLspClient] command ${command.command} failed:`, error);
    }
  }
}

function isCommand(value: unknown): value is Command {
  return (
    typeof value === "object" &&
    value !== null &&
    "command" in value &&
    typeof value.command === "string" &&
    "title" in value &&
    typeof value.title === "string"
  );
}
