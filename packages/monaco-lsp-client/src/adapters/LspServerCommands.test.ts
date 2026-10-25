import { beforeEach, describe, expect, mock, test } from "bun:test";

import { fakeMonaco, fakeMonacoModule } from "../testing/fake-monaco";
import type { ExecuteCommandParams, ExecuteCommandRegistrationOptions } from "../types";
import { api, capabilities } from "../types";
import type { IDisposable } from "../utils";
import type { ILspCapabilitiesRegistry } from "./LspCapabilitiesRegistry";

mock.module("monaco-editor", () => fakeMonacoModule);

const { LspServerCommands } = await import("./LspServerCommands");

function setup() {
  const executed: ExecuteCommandParams[] = [];
  const server = {
    workspaceExecuteCommand: async (params: ExecuteCommandParams) => {
      executed.push(params);
      return null;
    },
  } as unknown as typeof api.TServerInterface;

  let handler: ((options: ExecuteCommandRegistrationOptions) => IDisposable) | undefined;
  const registry: ILspCapabilitiesRegistry = {
    addStaticClientCapabilities: () => ({ dispose: () => {} }),
    registerCapabilityHandler: (capability, _handleStatic, h) => {
      if (capability === capabilities.workspaceExecuteCommand) handler = h as typeof handler;
      return { dispose: () => {} };
    },
  };
  const register = (commands: string[]) => {
    if (!handler) throw new Error("executeCommand handler not registered");
    return handler({ commands });
  };

  const commands = new LspServerCommands(server, registry);
  return { commands, executed, register };
}

async function runMonacoCommand(id: string, args: unknown[] = []) {
  const handler = fakeMonaco.commands.get(id);
  if (!handler) throw new Error(`command ${id} not registered`);
  await handler(undefined, ...args);
}

describe("LspServerCommands", () => {
  beforeEach(() => {
    fakeMonaco.reset();
  });

  test("routes advertised server commands through workspace/executeCommand", async () => {
    const { commands, executed, register } = setup();
    register(["pyright.organizeimports"]);

    const lspCommand = { title: "Organize", command: "pyright.organizeimports", arguments: ["a"] };
    const monacoCommand = commands.toMonacoCommand(lspCommand);
    expect(monacoCommand?.id).not.toBe("pyright.organizeimports");
    expect(monacoCommand?.title).toBe("Organize");

    await runMonacoCommand(monacoCommand.id, monacoCommand.arguments);
    expect(executed).toEqual([{ command: "pyright.organizeimports", arguments: ["a"] }]);
  });

  test("passes client commands through unchanged", () => {
    const { commands, register } = setup();
    register(["pyright.organizeimports"]);

    expect(
      commands.toMonacoCommand({ title: "Suggest", command: "editor.action.triggerSuggest" }),
    ).toEqual({ id: "editor.action.triggerSuggest", title: "Suggest", arguments: undefined });
  });

  test("stops routing a command once its registration is disposed", () => {
    const { commands, register } = setup();
    const first = register(["a.cmd"]);
    register(["a.cmd", "b.cmd"]);
    first.dispose();

    register(["c.cmd"]).dispose();

    expect(commands.toMonacoCommand({ title: "A", command: "a.cmd" })?.id).not.toBe("a.cmd");
    expect(commands.toMonacoCommand({ title: "B", command: "b.cmd" })?.id).not.toBe("b.cmd");
    expect(commands.toMonacoCommand({ title: "C", command: "c.cmd" })?.id).toBe("c.cmd");
  });

  test("refuses to send a command its server never advertised", async () => {
    const { commands, executed, register } = setup();
    register(["a.cmd"]);
    const monacoCommand = commands.toMonacoCommand({ title: "A", command: "a.cmd" });

    const forged = { title: "X", command: "other.cmd" };
    await expect(runMonacoCommand(monacoCommand.id, [forged])).rejects.toThrow("other.cmd");
    expect(executed).toEqual([]);
  });

  test("gives each client its own Monaco command and unregisters it on dispose", () => {
    const one = setup();
    const two = setup();
    expect(fakeMonaco.commands.size).toBe(2);

    one.commands.dispose();
    two.commands.dispose();
    expect(fakeMonaco.commands.size).toBe(0);
  });
});
