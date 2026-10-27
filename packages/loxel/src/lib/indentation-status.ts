import { getActiveEditorFilePath } from "@/lib/reveal-in-explorer";
import { type QuickPickItem, requestQuickPick } from "@/store/command-palette";
import { type EditorIndentation, useEditorIndentationStore } from "@/store/editor-indentation";
import type {
  IndentationResolution,
  IndentationSource,
  ResolvedIndentation,
} from "@/store/settings-store";

const SHORT_SOURCE_LABELS: Record<IndentationSource, string> = {
  file: "chosen for this file",
  editorconfig: ".editorconfig",
  override: "extension setting",
  detected: "detected",
  language: "language default",
  default: "default setting",
};

const SOURCE_DESCRIPTIONS: Record<IndentationSource, string> = {
  file: "chosen for this file",
  editorconfig: "from .editorconfig",
  override: "from your per-extension setting",
  detected: "detected from the file's content",
  language: "the language's default",
  default: "the default setting",
};

export interface IndentationDescription {
  /** `Spaces: 4` or `Tab Size: 4`. */
  label: string;
  /** Where the shown values came from, e.g. `.editorconfig` or `.editorconfig, detected`. */
  source: string;
  /** One line per property, plus a note when `.editorconfig` or a file choice outranks the user's per-extension override. */
  details: string[];
}

/** What the indentation status item shows for a file. */
export function describeIndentation({
  indentation,
  sources,
  override,
}: IndentationResolution): IndentationDescription {
  const { insertSpaces, tabSize, indentSize } = indentation;
  const sizeKey: keyof ResolvedIndentation = insertSpaces ? "indentSize" : "tabSize";
  const size = indentation[sizeKey];
  const shownSources = [...new Set([sources.insertSpaces, sources[sizeKey]])];
  const describe = (key: keyof ResolvedIndentation) => SOURCE_DESCRIPTIONS[sources[key]];

  const details = [
    `Indent with ${insertSpaces ? "spaces" : "tabs"}, ${describe("insertSpaces")}`,
    insertSpaces
      ? `Indent size ${indentSize}, ${describe("indentSize")}`
      : `Tab size ${tabSize}, ${describe("tabSize")}`,
  ];
  if (insertSpaces && tabSize !== indentSize) {
    details.push(`Tab size ${tabSize}, ${describe("tabSize")}`);
  }
  if (override && (override.insertSpaces !== insertSpaces || override.tabSize !== size)) {
    const outranking = shownSources.flatMap((s) => {
      if (s === "file") return ["your choice for this file"];
      return s === "editorconfig" ? [".editorconfig"] : [];
    });
    const style = override.insertSpaces
      ? `${override.tabSize} spaces`
      : `tabs, size ${override.tabSize}`;
    details.push(
      `Your setting for .${override.extension} files (${style}) is outranked by ${outranking.join(" and ")}`,
    );
  }

  return {
    label: insertSpaces ? `Spaces: ${size}` : `Tab Size: ${size}`,
    source: shownSources.map((s) => SHORT_SOURCE_LABELS[s]).join(", "),
    details,
  };
}

const SIZES = [1, 2, 3, 4, 5, 6, 7, 8];

/**
 * The Change Indentation flow for the active code editor: indent with spaces or tabs at a chosen
 * size, or convert the file's indentation. The choice lasts while the file's tab is open.
 */
export async function changeIndentation(
  filePath: string | null = getActiveEditorFilePath(),
): Promise<void> {
  const entry = filePath ? useEditorIndentationStore.getState().byFile.get(filePath) : undefined;
  if (!filePath || !entry) return;
  const { indentation, sources } = entry.resolution;
  const { label, source } = describeIndentation(entry.resolution);

  const items: QuickPickItem[] = [
    { id: "spaces", label: "Indent Using Spaces", current: indentation.insertSpaces },
    { id: "tabs", label: "Indent Using Tabs", current: !indentation.insertSpaces },
    { id: "toSpaces", label: "Convert Indentation to Spaces" },
    { id: "toTabs", label: "Convert Indentation to Tabs" },
  ];
  if (Object.values(sources).includes("file")) {
    items.push({
      id: "reset",
      label: "Reset to Automatic",
      description: ".editorconfig, settings or detection",
    });
  }
  const picked = await requestQuickPick({
    placeholder: `${label} (${source})`,
    items: Promise.resolve(items),
  });
  // The tab may have closed, or republished, while the palette was open.
  const current = (): EditorIndentation | undefined =>
    useEditorIndentationStore.getState().byFile.get(filePath);

  if (picked === "spaces" || picked === "tabs") {
    const insertSpaces = picked === "spaces";
    const shownSize = insertSpaces ? indentation.indentSize : indentation.tabSize;
    const size = await requestQuickPick({
      placeholder: insertSpaces ? "Select the indent size" : "Select the tab size",
      items: Promise.resolve(
        SIZES.map((n) => ({
          id: String(n),
          label: String(n),
          current: indentation.insertSpaces === insertSpaces && n === shownSize,
        })),
      ),
    });
    if (size === null) return;
    const n = Number(size);
    current()?.setFileChoice({ insertSpaces, tabSize: n, indentSize: n });
  } else if (picked === "toSpaces" || picked === "toTabs") {
    current()?.convert(picked === "toSpaces");
  } else if (picked === "reset") {
    current()?.setFileChoice(null);
  }
}
