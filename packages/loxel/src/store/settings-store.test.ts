import { describe, expect, test } from "bun:test";

import { DEFAULT_MARKDOWN_OUTPUT_SETTINGS } from "@/lib/formatting-model";

import type { SettingsState } from "./settings-store";
import { useSettingsStore } from "./settings-store";

function migrate(persisted: unknown, version: number): SettingsState {
  const { migrate: run } = useSettingsStore.persist.getOptions();
  if (!run) throw new Error("settings store has no migrate function");
  const migrated = run(persisted, version);
  if (migrated instanceof Promise) throw new Error("expected synchronous migration");
  // zustand types the migrated value as unknown; the store's migrate returns SettingsState.
  return migrated as SettingsState;
}

describe("settings store migrations", () => {
  test("v10 → v11 fills markdownOutput defaults into existing formatting settings", () => {
    const migrated = migrate(
      {
        editor: {
          formatting: { enabled: true, formatOnAutoSave: false, autoDetect: true, overrides: [] },
        },
      },
      10,
    );
    expect(migrated.editor.formatting.markdownOutput).toEqual(DEFAULT_MARKDOWN_OUTPUT_SETTINGS);
    expect(migrated.editor.formatting.enabled).toBe(true);
  });

  test("v10 → v11 keeps valid pre-existing markdownOutput values", () => {
    const migrated = migrate(
      {
        editor: {
          formatting: {
            enabled: true,
            overrides: [],
            markdownOutput: { bullet: "*", setext: true },
          },
        },
      },
      10,
    );
    expect(migrated.editor.formatting.markdownOutput).toEqual({
      ...DEFAULT_MARKDOWN_OUTPUT_SETTINGS,
      bullet: "*",
      setext: true,
    });
  });

  test("v7 → v11 chain adds formatting including markdownOutput", () => {
    const migrated = migrate({ editor: { indentation: { tabSize: 2, insertSpaces: true } } }, 7);
    expect(migrated.editor.formatting.markdownOutput).toEqual(DEFAULT_MARKDOWN_OUTPUT_SETTINGS);
  });

  test("updateMarkdownOutput merges partial updates", () => {
    useSettingsStore.getState().updateMarkdownOutput({ fence: "~" });
    const { markdownOutput } = useSettingsStore.getState().editor.formatting;
    expect(markdownOutput.fence).toBe("~");
    expect(markdownOutput.bullet).toBe(DEFAULT_MARKDOWN_OUTPUT_SETTINGS.bullet);
  });
});
