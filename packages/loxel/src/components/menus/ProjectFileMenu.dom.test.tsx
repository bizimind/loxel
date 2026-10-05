import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ProjectFileMenu } from "./ProjectFileMenu";

const writeText = mock((_text: string) => Promise.resolve());
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  cleanup();
  if (originalClipboard) {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
});

function renderMenu(props: { filePath: string; relativePath?: string; isDir?: boolean }) {
  const onClose = mock(() => {});
  render(
    <ProjectFileMenu
      open
      position={{ x: 0, y: 0 }}
      filePath={props.filePath}
      relativePath={props.relativePath}
      isDir={props.isDir ?? false}
      onClose={onClose}
    />,
  );
  return { onClose };
}

describe("ProjectFileMenu copy items", () => {
  test.each([
    ["Copy Name", "Button.tsx"],
    ["Copy Relative Path", "src/components/Button.tsx"],
    ["Copy Absolute Path", "/repo/src/components/Button.tsx"],
  ])("%s copies %s and closes the menu", (label, expected) => {
    const { onClose } = renderMenu({
      filePath: "/repo/src/components/Button.tsx",
      relativePath: "src/components/Button.tsx",
    });

    fireEvent.click(screen.getByText(label));

    expect(writeText).toHaveBeenCalledWith(expected);
    expect(onClose).toHaveBeenCalled();
  });

  test("copies a folder's name", () => {
    renderMenu({ filePath: "/repo/src/components", relativePath: "src/components", isDir: true });

    fireEvent.click(screen.getByText("Copy Name"));

    expect(writeText).toHaveBeenCalledWith("components");
  });

  test("hides Copy Relative Path without a relative path", () => {
    renderMenu({ filePath: "/repo", isDir: true });

    expect(screen.getByText("Copy Name")).toBeInTheDocument();
    expect(screen.getByText("Copy Absolute Path")).toBeInTheDocument();
    expect(screen.queryByText("Copy Relative Path")).toBeNull();
  });
});
