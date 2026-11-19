import { afterEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { DockviewApi, IDockviewPanelProps } from "dockview-react";

import { localRef } from "@/api/local-server";
import { type ServerId, toServerId, worktreeRef } from "@/api/worktree-ref";

/** What the server's store holds, by key; nothing is stored until the layout writes it. */
const stored = new Map<string, string>();
const originalClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...originalClient,
  getStore: async (key: string) => stored.get(key) ?? null,
  putStore: async (key: string, value: string) => void stored.set(key, value),
}));

const { PersistedLayoutComponent } = await import("./PersistedLayout");
const { useLayoutServer } = await import("./panel-context");
const { layoutKeyOf } = await import("@/store/active-worktree");

const PATH = "/repo";
const HERE = localRef(PATH);
/** The same path on another server. */
const THERE = worktreeRef(toServerId("other-server"), PATH);

/** Each render of a probe panel: the layout it was created for, and the server it was given. */
const seen: { layout: ServerId; server: ServerId }[] = [];
function Probe(props: IDockviewPanelProps<{ layout: ServerId }>) {
  seen.push({ layout: props.params.layout, server: useLayoutServer() });
  return null;
}
const components = { probe: Probe };

function layoutFor(server: ServerId) {
  return (api: DockviewApi) =>
    api.addPanel({ id: `probe-${server}`, component: "probe", params: { layout: server } });
}

afterEach(() => {
  cleanup();
  stored.clear();
  seen.length = 0;
});

describe("PersistedLayoutComponent", () => {
  test("swaps to another server's layout of the same path, and gives its panels that server", async () => {
    const view = render(
      <PersistedLayoutComponent
        storagePrefix="test"
        layoutKey={layoutKeyOf(HERE)}
        layoutVersion={1}
        createDefaultLayout={layoutFor(HERE.server)}
        components={components}
      />,
    );
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));

    act(() =>
      view.rerender(
        <PersistedLayoutComponent
          storagePrefix="test"
          layoutKey={layoutKeyOf(THERE)}
          layoutVersion={1}
          createDefaultLayout={layoutFor(THERE.server)}
          components={components}
        />,
      ),
    );

    await waitFor(() => expect(seen.some(({ layout }) => layout === THERE.server)).toBe(true));
    // Every panel only ever sees the server of the layout it was created for.
    expect(seen.every(({ layout, server }) => layout === server)).toBe(true);
    // Stored under the bare path on the window's server; the other server's layout is not stored
    // there, so it never took the window's row of the same path.
    expect([...stored.keys()]).toHaveLength(1);
    expect([...stored.keys()].every((key) => key.endsWith(`:test:${PATH}`))).toBe(true);
  });
});
