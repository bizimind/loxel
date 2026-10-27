import { afterEach, describe, expect, mock, test } from "bun:test";

import { type QuickPickItem, useCommandPaletteStore } from "@/store/command-palette";
import { type EditorIndentation, useEditorIndentationStore } from "@/store/editor-indentation";
import {
  DEFAULT_EDITOR_SETTINGS,
  type IndentationInputs,
  type IndentationOverride,
  type IndentationResolution,
  resolveIndentation,
} from "@/store/settings-store";

import { changeIndentation, describeIndentation } from "./indentation-status";

function resolve(
  filePath: string,
  inputs: IndentationInputs,
  overrides: IndentationOverride[] = [],
): IndentationResolution {
  return resolveIndentation({ ...DEFAULT_EDITOR_SETTINGS, overrides }, filePath, inputs);
}

describe("describeIndentation", () => {
  test("shows spaces with the indent size and its source", () => {
    const description = describeIndentation(
      resolve("/repo/a.ts", {
        language: "typescript",
        detected: { insertSpaces: true, tabSize: 4, indentSize: 4 },
      }),
    );
    expect(description).toEqual({
      label: "Spaces: 4",
      source: "detected",
      details: [
        "Indent with spaces, detected from the file's content",
        "Indent size 4, detected from the file's content",
      ],
    });
  });

  test("shows tabs with the tab size, and each source once", () => {
    const description = describeIndentation(
      resolve("/repo/main.go", { language: "go", detected: { insertSpaces: false } }),
    );
    expect(description.label).toBe("Tab Size: 4");
    expect(description.source).toBe("detected, language default");

    const fromEditorConfig = describeIndentation(
      resolve("/repo/main.go", {
        language: "go",
        editorConfig: { indentStyle: "tab", indentSize: 8, tabWidth: 8 },
      }),
    );
    expect(fromEditorConfig.label).toBe("Tab Size: 8");
    expect(fromEditorConfig.source).toBe(".editorconfig");
  });

  test("adds the tab size when it differs from the indent size", () => {
    const { details } = describeIndentation(
      resolve("/repo/a.c", {
        language: "c",
        editorConfig: { indentStyle: "space", indentSize: 4, tabWidth: 8 },
      }),
    );
    expect(details).toContain("Tab size 8, from .editorconfig");
  });

  test("notes a per-extension override that .editorconfig outranks", () => {
    const override = { id: "1", extension: "py", tabSize: 2, insertSpaces: true };
    const masked = describeIndentation(
      resolve(
        "/repo/a.py",
        { language: "python", editorConfig: { indentStyle: "space", indentSize: 4 } },
        [override],
      ),
    );
    expect(masked.source).toBe(".editorconfig");
    expect(masked.details).toContain(
      "Your setting for .py files (2 spaces) is outranked by .editorconfig",
    );

    // Agreeing values are not called out.
    const agreeing = describeIndentation(
      resolve(
        "/repo/a.py",
        { language: "python", editorConfig: { indentStyle: "space", indentSize: 2 } },
        [override],
      ),
    );
    expect(agreeing.details.some((d) => d.includes("outranked"))).toBe(false);

    const applied = describeIndentation(resolve("/repo/a.py", { language: "python" }, [override]));
    expect(applied).toMatchObject({ label: "Spaces: 2", source: "settings" });
  });
});

describe("changeIndentation", () => {
  const filePath = "/repo/a.ts";
  const setFileChoice = mock<EditorIndentation["setFileChoice"]>();
  const convert = mock<EditorIndentation["convert"]>();

  function publish(inputs: IndentationInputs): void {
    useEditorIndentationStore
      .getState()
      .publish(filePath, {
        resolution: resolve(filePath, inputs),
        eol: "LF",
        setFileChoice,
        convert,
      });
  }

  /** Waits for the palette to show a loaded pick list. */
  function shownPick(): Promise<{ placeholder: string; items: QuickPickItem[] }> {
    return new Promise((done) => {
      const check = (): boolean => {
        const { mode } = useCommandPaletteStore.getState();
        if (mode.kind !== "pick" || mode.items === null) return false;
        done({ placeholder: mode.placeholder, items: mode.items });
        return true;
      };
      if (check()) return;
      const unsubscribe = useCommandPaletteStore.subscribe(() => {
        if (check()) unsubscribe();
      });
    });
  }

  afterEach(() => {
    useCommandPaletteStore.getState().close();
    useEditorIndentationStore.getState().remove(filePath);
    setFileChoice.mockClear();
    convert.mockClear();
  });

  test("sets spaces at a chosen size for the file", async () => {
    publish({ language: "typescript" });
    const done = changeIndentation(filePath);
    const first = await shownPick();
    expect(first.placeholder).toBe("Spaces: 2 (default)");
    expect(first.items.map((i) => i.id)).toEqual(["spaces", "tabs", "toSpaces", "toTabs"]);
    useCommandPaletteStore.getState().submit("spaces");

    const sizes = await shownPick();
    expect(sizes.items.find((i) => i.current)?.id).toBe("2");
    useCommandPaletteStore.getState().submit("4");
    await done;
    expect(setFileChoice).toHaveBeenCalledWith({ insertSpaces: true, tabSize: 4, indentSize: 4 });
  });

  test("converts the file's indentation", async () => {
    publish({ language: "typescript" });
    const done = changeIndentation(filePath);
    await shownPick();
    useCommandPaletteStore.getState().submit("toTabs");
    await done;
    expect(convert).toHaveBeenCalledWith(false);
  });

  test("offers a reset once a choice was made for the file", async () => {
    publish({ language: "typescript", fileChoice: { insertSpaces: false } });
    const done = changeIndentation(filePath);
    const { items } = await shownPick();
    expect(items.at(-1)?.id).toBe("reset");
    useCommandPaletteStore.getState().submit("reset");
    await done;
    expect(setFileChoice).toHaveBeenCalledWith(null);
  });

  test("does nothing without a code editor for the file", async () => {
    await changeIndentation(filePath);
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });
});
