import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { localServerId } from "@/api/local-server";
import { type ServerId, toServerId } from "@/api/worktree-ref";

// No model is ever found, so no editor is created: only the header's state is under test.
mock.module("monaco-editor", () => ({
  Uri: { from: (parts: object) => parts },
  editor: { getModel: () => null, createModel: () => ({ dispose() {} }), setTheme() {} },
}));
mock.module("@/lib/monaco-theme", () => ({ getMonacoThemeName: () => "loxel-dark" }));

const { FrontmatterEditor } = await import("./FrontmatterEditor");
const { LayoutServerContext } = await import("@/components/dockview/panel-context");

/** Another server, holding the same paths as the window's. */
const THERE = toServerId("other-server");
const FILE = "/repo/notes.md";

afterEach(cleanup);

function renderFor(server: ServerId) {
  return render(
    <LayoutServerContext.Provider value={server}>
      <FrontmatterEditor
        filePath={FILE}
        value="title: Notes"
        onChange={() => {}}
        isProgrammaticRef={{ current: false }}
      />
    </LayoutServerContext.Provider>,
  );
}

function isExpanded(container: HTMLElement): boolean {
  return container.querySelector(".frontmatter-editor") !== null;
}

describe("the frontmatter editor", () => {
  test("keeps a file's collapse state apart from the same path's on another server", () => {
    const here = renderFor(localServerId());
    expect(isExpanded(here.container)).toBe(true);
    fireEvent.click(screen.getByText("Frontmatter"));
    expect(isExpanded(here.container)).toBe(false);
    here.unmount();

    expect(isExpanded(renderFor(THERE).container)).toBe(true);
    cleanup();
    expect(isExpanded(renderFor(localServerId()).container)).toBe(false);
  });
});
