import { afterAll, describe, expect, mock, test } from "bun:test";

import type * as monaco from "monaco-editor";
import { IBulkEditService } from "monaco-editor/editor/browser/services/bulkEditService.js";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";

/** Edits the client's rename provider handed Monaco, with what each stands for. */
const handed = new Map<monaco.languages.WorkspaceEdit, { edits: number; files: number } | null>();
const realClient = await import("@bizimind/monaco-lsp-client");
mock.module("@bizimind/monaco-lsp-client", () => ({
  ...realClient,
  appliedRenameSummary: (edit: monaco.languages.WorkspaceEdit) => handed.get(edit),
}));

const { installRenameSummary } = await import("./rename-summary");

const installed = installRenameSummary();
const service = StandaloneServices.get(IBulkEditService);

afterAll(() => installed.dispose());

describe("installRenameSummary", () => {
  test("summarizes what a language client's rename changed", async () => {
    const edit: monaco.languages.WorkspaceEdit = { edits: [] };
    handed.set(edit, { edits: 3, files: 2 });

    expect(await service.apply(edit)).toEqual({
      ariaSummary: "Made 3 edits in 2 files",
      isApplied: true,
    });
  });

  test("announces nothing for a rename the client failed to apply", async () => {
    const edit: monaco.languages.WorkspaceEdit = { edits: [] };
    handed.set(edit, null);

    expect(await service.apply(edit)).toEqual({ ariaSummary: "", isApplied: false });
  });

  test("leaves every other edit to Monaco's service", async () => {
    expect(await service.apply({ edits: [] })).toEqual({
      ariaSummary: "Made 0 edits in 0 files",
      isApplied: false,
    });
  });
});
