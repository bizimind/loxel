import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const actualProjects = await import("@/store/projects");
mock.module("@/store/projects", () => ({ ...actualProjects, whenProjectsLoaded: async () => {} }));

const { onLoxelEvent } = await import("./loxel-events");
const { dispatchPendingOpen, openFile, openFromInbox, openPath, openUrl, dropInboxOpen } =
  await import("./open-path");
const { wsClient } = await import("@/api/client");
const { useProjectStore } = actualProjects;
const { setCenterApi } = await import("@/store/tools-bar");
const { HOME_LAYOUT_KEY } = await import("@/store/active-worktree");
const { getWorktreeUI } = await import("@/store/worktree-ui");
const { useWorktreeStore } = await import("@/store/worktrees");

const MAIN = "/repo";
const OTHER = "/repo/.worktrees/other";
const URL_TARGET = "https://example.com/pull/1";

describe("opens from outside the window", () => {
  let created: Array<{ url?: string; focus?: boolean }>;
  let openedFiles: string[];
  let switched: string[];
  let cleanups: Array<() => void>;

  beforeEach(() => {
    created = [];
    openedFiles = [];
    switched = [];
    cleanups = [
      onLoxelEvent("loxel-create-browser", (detail) => created.push(detail)),
      onLoxelEvent("loxel-open-markdown-editor", (detail) => openedFiles.push(detail.filePath)),
    ];
    useProjectStore.setState({
      projects: [
        { path: MAIN, isBare: false, worktrees: [{ path: MAIN }, { path: OTHER }] },
      ] as never,
    });
    useWorktreeStore.setState({
      byProject: {},
      activeWorktreePath: MAIN,
      switchWorktree: async (path: string) => {
        switched.push(path);
        useWorktreeStore.setState({ activeWorktreePath: path });
      },
    });
    setCenterApi({} as never, MAIN);
  });

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    for (const key of [MAIN, OTHER, HOME_LAYOUT_KEY])
      getWorktreeUI(key).getState().takePendingOpens();
    setCenterApi(null);
  });

  const pending = (worktree: string) => getWorktreeUI(worktree).getState().pendingOpens;

  test("a page for the worktree on screen opens right away", async () => {
    await openUrl(MAIN, { url: URL_TARGET });

    expect(created.map((detail) => detail.url)).toEqual([URL_TARGET]);
    expect(switched).toEqual([]);
  });

  test("a link naming no worktree opens in the worktree on screen", async () => {
    await openUrl(null, { url: URL_TARGET });

    expect(created.map((detail) => detail.url)).toEqual([URL_TARGET]);
    expect(switched).toEqual([]);
  });

  test("a link naming no worktree opens in Home when it is on screen", async () => {
    useWorktreeStore.setState({ activeWorktreePath: null });
    setCenterApi({} as never, HOME_LAYOUT_KEY);

    await openUrl(null, { url: URL_TARGET });

    expect(created.map((detail) => detail.url)).toEqual([URL_TARGET]);
    expect(switched).toEqual([]);
  });

  test("a link waits for Home's editor area to mount, as at a launch with the link", async () => {
    useWorktreeStore.setState({ activeWorktreePath: null });
    setCenterApi(null);

    await openUrl(null, { url: URL_TARGET });

    expect(created).toEqual([]);
    expect(switched).toEqual([]);
    expect(pending(HOME_LAYOUT_KEY)).toEqual([{ kind: "url", url: URL_TARGET }]);
  });

  test("a file link in Home opens in the worktree holding it, switching there", async () => {
    useWorktreeStore.setState({ activeWorktreePath: null });
    setCenterApi({} as never, HOME_LAYOUT_KEY);

    await openPath(`${OTHER}/a.md`, { line: 3, column: 1 });

    expect(switched).toEqual([OTHER]);
    expect(pending(OTHER)).toEqual([
      { kind: "file", path: `${OTHER}/a.md`, location: { line: 3, column: 1 } },
    ]);
  });

  test("a link between Home's plans opens in Home", async () => {
    useWorktreeStore.setState({ activeWorktreePath: null });
    useProjectStore.setState({ homeDraftsDir: "/state/detached/home" });
    setCenterApi({} as never, HOME_LAYOUT_KEY);

    await openPath("/state/detached/home/Plan.md");

    expect(openedFiles).toEqual(["/state/detached/home/Plan.md"]);
    expect(switched).toEqual([]);
    useProjectStore.setState({ homeDraftsDir: null });
  });

  test("a file link in Home to a file in no worktree opens nothing", async () => {
    useWorktreeStore.setState({ activeWorktreePath: null });
    setCenterApi({} as never, HOME_LAYOUT_KEY);

    await openPath("/elsewhere/notes.md");

    expect(openedFiles).toEqual([]);
    expect(switched).toEqual([]);
    expect(pending(HOME_LAYOUT_KEY)).toEqual([]);
  });

  test("a page for another worktree waits for it and switches there", async () => {
    await openUrl(OTHER, { url: URL_TARGET });

    expect(created).toEqual([]);
    expect(switched).toEqual([OTHER]);
    expect(pending(OTHER)).toEqual([{ kind: "url", url: URL_TARGET }]);
  });

  test("without focus a page for another worktree waits there, leaving the window alone", async () => {
    await openUrl(OTHER, { url: URL_TARGET, focus: false });

    expect(created).toEqual([]);
    expect(switched).toEqual([]);
    expect(pending(OTHER)).toEqual([{ kind: "url", url: URL_TARGET, focus: false }]);
  });

  test("an open from the inbox is done with once its panel is placed, and opens once", async () => {
    const sent: unknown[] = [];
    const send = spyOn(wsClient, "send").mockImplementation((message) => sent.push(message));
    cleanups.push(() => send.mockRestore());
    const message = {
      type: "open_url" as const,
      wtPath: OTHER,
      data: { url: URL_TARGET, focus: false },
    };

    await openFromInbox("in-1", message);
    // Sent again after a reconnect, before the user went to the worktree.
    await openFromInbox("in-1", message);
    expect(pending(OTHER)).toHaveLength(1);
    expect(sent).toEqual([]);

    for (const open of getWorktreeUI(OTHER).getState().takePendingOpens())
      dispatchPendingOpen(open);
    expect(created.map((detail) => detail.url)).toEqual([URL_TARGET]);
    const done = { type: "inbox_open_done", inboxId: "in-1" };
    expect(sent).toEqual([done]);

    // The server missed the answer: it gets it again, and no second panel opens.
    await openFromInbox("in-1", message);
    expect(sent).toEqual([done, done]);
    expect(created).toHaveLength(1);
  });

  test("an open from the inbox another window placed is not placed here", async () => {
    const sent: unknown[] = [];
    const send = spyOn(wsClient, "send").mockImplementation((message) => sent.push(message));
    cleanups.push(() => send.mockRestore());
    const message = {
      type: "open_url" as const,
      wtPath: OTHER,
      data: { url: URL_TARGET, focus: false },
    };

    await openFromInbox("in-2", message);
    dropInboxOpen("in-2");
    for (const open of getWorktreeUI(OTHER).getState().takePendingOpens())
      dispatchPendingOpen(open);
    expect(created).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("an open from the inbox placed elsewhere while on its way is neither placed nor answered", async () => {
    const sent: unknown[] = [];
    const send = spyOn(wsClient, "send").mockImplementation((message) => sent.push(message));
    cleanups.push(() => send.mockRestore());

    const opening = openFromInbox("in-3", {
      type: "open_url",
      wtPath: MAIN,
      data: { url: URL_TARGET },
    });
    dropInboxOpen("in-3");
    await opening;
    expect(created).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("an open from the inbox that fails here is left to the other windows", async () => {
    const sent: unknown[] = [];
    const send = spyOn(wsClient, "send").mockImplementation((message) => sent.push(message));
    cleanups.push(() => send.mockRestore());
    // In Home, a file outside every worktree has nowhere to open.
    useWorktreeStore.setState({ activeWorktreePath: null });

    await openFromInbox("in-4", { type: "open_file", data: { filePath: "/elsewhere/notes.md" } });
    expect(openedFiles).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("targets arriving during a switch keep their order in the new worktree", async () => {
    await openFile({ filePath: `${OTHER}/a.md` });
    await openUrl(OTHER, { url: URL_TARGET });
    await openFile({ filePath: `${OTHER}/b.md` });

    expect(switched).toEqual([OTHER]);
    expect(created).toEqual([]);
    expect(openedFiles).toEqual([]);
    expect(pending(OTHER)).toEqual([
      { kind: "file", path: `${OTHER}/a.md` },
      { kind: "url", url: URL_TARGET },
      { kind: "file", path: `${OTHER}/b.md` },
    ]);
  });

  test("a named worktree overrides the one holding the file", async () => {
    await openFile({ filePath: `${MAIN}/a.md`, worktreePath: OTHER });

    expect(openedFiles).toEqual([]);
    expect(pending(OTHER)).toEqual([{ kind: "file", path: `${MAIN}/a.md` }]);
  });

  test("a file with no named worktree opens in the one holding it", async () => {
    await openFile({ filePath: `${MAIN}/a.md` });

    expect(openedFiles).toEqual([`${MAIN}/a.md`]);
  });

  test("targets keep their order while one refreshes a worktree list", async () => {
    const fresh = "/repo/.worktrees/fresh";
    const refresh = Promise.withResolvers<void>();
    const refreshStarted = Promise.withResolvers<void>();
    useWorktreeStore.setState({
      refreshProjectWorktrees: () => {
        refreshStarted.resolve();
        return refresh.promise;
      },
    });

    const first = openUrl(fresh, { url: URL_TARGET, focus: false });
    const second = openFile({ filePath: `${MAIN}/a.md` });
    await refreshStarted.promise;
    expect(openedFiles).toEqual([]);

    refresh.resolve();
    await Promise.all([first, second]);
    expect(pending(fresh)).toEqual([{ kind: "url", url: URL_TARGET, focus: false }]);
    expect(openedFiles).toEqual([`${MAIN}/a.md`]);
    getWorktreeUI(fresh).getState().takePendingOpens();
  });

  test("a failed worktree refresh still opens in the worktree the server named", async () => {
    const fresh = "/repo/.worktrees/fresh";
    useWorktreeStore.setState({
      refreshProjectWorktrees: async () => {
        throw new Error("git failed");
      },
    });

    await openUrl(fresh, { url: URL_TARGET, focus: false });

    expect(pending(fresh)).toEqual([{ kind: "url", url: URL_TARGET, focus: false }]);
    getWorktreeUI(fresh).getState().takePendingOpens();
  });
});
