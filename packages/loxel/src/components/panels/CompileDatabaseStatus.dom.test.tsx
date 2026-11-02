import { afterEach, describe, expect, jest, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type {
  CompileDatabaseFileResponse,
  CompileDatabaseStatus,
} from "@/api/c-cpp-compile-database-model";

const STATUS: CompileDatabaseStatus = {
  chosen: null,
  chosenUsable: false,
  automatic: "/wt/cmake-build-debug",
  candidates: ["/wt/cmake-build-debug"],
  foundByClangd: [],
  searchCut: false,
};

const originalClient = await import("@/api/c-cpp-compile-database-client");
const getCompileDatabaseStatus = jest.fn(async (): Promise<CompileDatabaseStatus> => STATUS);
const getFileCompileDatabase = jest.fn(async (): Promise<CompileDatabaseFileResponse> => ({
  database: { path: "/wt/cmake-build-debug/compile_commands.json", source: "automatic" },
  clangdConfig: null,
  hint: null,
}));
mock.module("@/api/c-cpp-compile-database-client", () => ({
  ...originalClient,
  getCompileDatabaseStatus,
  getFileCompileDatabase,
}));

const originalPicker = await import("@/lib/c-cpp-compile-database");
const selectCompileDatabase = jest.fn(async (_wtPath: string) => {});
mock.module("@/lib/c-cpp-compile-database", () => ({ ...originalPicker, selectCompileDatabase }));

let activePanel = {
  id: "codeeditor-/wt/src/a.cpp",
  params: { filePath: "/wt/src/a.cpp", worktreePath: "/wt" },
};
const originalToolsBar = await import("@/store/tools-bar");
mock.module("@/store/tools-bar", () => ({
  ...originalToolsBar,
  getCenterApi: () => ({ activePanel, onDidActivePanelChange: () => ({ dispose: () => {} }) }),
  subscribeCenterApi: () => () => {},
}));

const { CompileDatabaseStatusItem } = await import("./CompileDatabaseStatus");

function renderItem() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CompileDatabaseStatusItem />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("CompileDatabaseStatusItem", () => {
  test("names the file's database and opens the picker for its worktree", async () => {
    renderItem();
    const button = await screen.findByRole("button", { name: "C++ (cmake-build-debug)" });
    expect(getFileCompileDatabase).toHaveBeenCalledWith({
      worktreePath: "/wt",
      filePath: "/wt/src/a.cpp",
    });
    fireEvent.click(button);
    expect(selectCompileDatabase).toHaveBeenCalledWith("/wt");
  });

  test("shows nothing for a file of another language", () => {
    activePanel = {
      id: "codeeditor-/wt/a.py",
      params: { filePath: "/wt/a.py", worktreePath: "/wt" },
    };
    renderItem();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
