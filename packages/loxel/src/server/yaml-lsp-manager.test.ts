import { describe, expect, test } from "bun:test";

import { withSchemaLensesAsLabels } from "./yaml-lsp-manager";

describe("withSchemaLensesAsLabels", () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  const frame = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 7, result });

  test("keeps each schema lens's title and drops its command", () => {
    const lens = {
      range,
      command: { title: "Demo (a.json)", command: "jumpToSchema", arguments: ["x"] },
    };
    expect(JSON.parse(withSchemaLensesAsLabels(frame([lens, lens]))).result).toEqual([
      { range, command: { title: "Demo (a.json)", command: "" } },
      { range, command: { title: "Demo (a.json)", command: "" } },
    ]);
  });

  test("leaves other frames as they are", () => {
    const capabilities = frame({
      capabilities: { executeCommandProvider: { commands: ["jumpToSchema"] } },
    });
    expect(withSchemaLensesAsLabels(capabilities)).toBe(capabilities);
    const other = frame([{ range, command: { title: "t", command: "other" } }]);
    expect(withSchemaLensesAsLabels(other)).toBe(other);
  });
});
