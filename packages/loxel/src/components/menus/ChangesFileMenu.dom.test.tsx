import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";

import { toServerId } from "@/api/worktree-ref";

/** The servers asked whether the file is on disk. */
const checkedOn: string[] = [];
const originalClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...originalClient,
  getPathInfo: async (server: string, path: string) => {
    checkedOn.push(server);
    return { path, isDir: false };
  },
}));

const { ChangesFileMenu } = await import("./ChangesFileMenu");
const { LayoutServerContext } = await import("@/components/dockview/panel-context");
const { queryKeys } = await import("@/queries/query-keys");

/** Another server, holding the same paths as the window's. */
const THERE = toServerId("other-server");
const FILE = "/repo/a.ts";

afterEach(cleanup);

describe("a changes entry's menu", () => {
  test("checks the file on the server of its panel", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <LayoutServerContext.Provider value={THERE}>
          <ChangesFileMenu
            position={{ x: 0, y: 0 }}
            path="a.ts"
            absolutePath={FILE}
            isDir={false}
            onClose={() => {}}
          />
        </LayoutServerContext.Provider>
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.pathExists(THERE, FILE))).toBe(true),
    );
    expect(checkedOn).toEqual([THERE]);
  });
});
