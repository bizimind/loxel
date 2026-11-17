import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { act, cleanup, render } from "@testing-library/react";
import type { DockviewPanelApi } from "dockview-react";

import * as api from "@/api/client";
import { PanelContext } from "@/components/dockview/panel-context";
import { dispatchLoxelEvent } from "@/lib/loxel-events";

import { MediaViewerPanel } from "./MediaViewerPanel";

const WT = "/repo/.worktrees/wt";
const FILE = `${WT}/logo.png`;

const panelApi = { updateParameters: () => {}, setTitle: () => {} } as unknown as DockviewPanelApi;

let stamp = { size: 10, mtimeMs: 1 };
let reads: Array<Promise<unknown>> = [];

beforeEach(() => {
  // happy-dom reports every frame it is not allowed to load; the frame's URL is all this checks.
  spyOn(console, "error").mockImplementation(() => {});
  stamp = { size: 10, mtimeMs: 1 };
  reads = [];
  spyOn(api, "getPathInfo").mockImplementation((path) => {
    const read = Promise.resolve({ path, isDir: false, ...stamp });
    reads.push(read);
    return read;
  });
});

afterEach(() => {
  cleanup();
  mock.restore();
});

function renderPanel() {
  const view = render(
    <PanelContext.Provider value={{ worktreePath: WT }}>
      <MediaViewerPanel filePath={FILE} panelApi={panelApi} />
    </PanelContext.Provider>,
  );
  return () => view.container.querySelector("iframe")!.getAttribute("src");
}

/** Dispatch a resync of `wtPath`, and let the reads it starts and their comparison settle. */
async function resync(wtPath: string): Promise<void> {
  await act(async () => {
    dispatchLoxelEvent("loxel-worktree-files-resynced", { wtPath });
    await Promise.all(reads);
  });
  await act(() => Promise.all(reads));
}

describe("MediaViewerPanel after a resync", () => {
  test("keeps the media when the file did not change", async () => {
    const src = renderPanel();
    const before = src();
    await resync(WT);
    expect(src()).toBe(before);
  });

  test("reloads the media when the file changed while no push reached the window", async () => {
    const src = renderPanel();
    const before = src();
    await act(() => Promise.all(reads));
    stamp = { size: 12, mtimeMs: 2 };
    await resync("/repo/.worktrees/other");
    expect(src()).toBe(before);

    await resync(WT);
    expect(src()).not.toBe(before);
    expect(src()).toContain("&v=2");
  });
});
