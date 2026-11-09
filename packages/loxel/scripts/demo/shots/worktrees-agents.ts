import {
  type Agent,
  acceptTrust,
  agentCommand,
  dragDivider,
  finishAgent,
  focusTerminal,
  group,
  groupRect,
  panelPoint,
  row,
  scrollEditorTo,
  type Shot,
  type TerminalRef,
  until,
} from "../shot-kit";

const DOCKVIEW = "packages/loxel/src/components/dockview";

/** Shot 1 in shots.md: the lead task, with agents at work. */
export default async function worktreesAgents(s: Shot): Promise<void> {
  const worktree = s.worktree("loxel", "maximize-group");
  const tests: TerminalRef = { worktree, title: "tests" };
  const lead: Agent = {
    worktree,
    title: "claude",
    kind: "claude",
    prompt: `How does maximizing a group work end to end on this branch? Five one-line bullets.`,
    next: "Nice. Add an end-to-end test that maximizes a group from the tab menu, in a subtask worktree with its own agent",
  };
  const review: Agent = {
    worktree,
    title: "codex · review",
    kind: "codex",
    prompt: `Review this branch's changes under ${DOCKVIEW} against main. What are the three riskiest spots?`,
    next: "Write a test for restoring a maximized group after a reload",
  };
  await row(s.page, "Maximize a group").click();
  await s.loxel(
    "loxel",
    "maximize-group",
    "terminal",
    "--title",
    lead.title,
    "--focus",
    "--",
    ...agentCommand(s, lead),
  );
  await acceptTrust(s, lead);
  // The test run first, so its strip spans the whole width under everything else.
  await s.loxel(
    "loxel",
    "maximize-group",
    "terminal",
    "--title",
    tests.title,
    "--group",
    lead.title,
    "--split",
    "down",
    "--no-focus",
    "--",
    "cd packages/loxel && clear && bun test src/components/dockview/maximized-group-actions.dom.test.tsx src/components/dockview/drop-unregistered-panels.test.ts --preload ./src/test/dom-preload.ts --preload ./src/test/jest-dom-preload.ts; echo",
  );
  // The PR's new tab menu entry: its lines fit the editor, where the new header button's don't.
  const editor = `${DOCKVIEW}/tab.tsx`;
  await s.loxel(
    "loxel",
    "maximize-group",
    "--group",
    lead.title,
    "--split",
    "right",
    "--focus",
    editor,
  );
  await s.loxel(
    "loxel",
    "maximize-group",
    "terminal",
    "--title",
    review.title,
    "--group",
    editor,
    "--split",
    "down",
    "--focus",
    "--",
    ...agentCommand(s, review),
  );
  await acceptTrust(s, review);
  await s.loxel(
    "loxel",
    "tiling-menu",
    "terminal",
    "--title",
    "claude",
    "--no-focus",
    "--",
    "printf",
    "\\033]9;%s\\007",
    "Use the role or a custom item?",
  );
  await row(s.page, "Window tiling keys").locator(".wt-knob[aria-expanded=true]").click();

  await finishAgent(s, lead);
  await finishAgent(s, review);
  await s.terminals.waitFor(tests, /\d+pass/, 60_000, { fromStart: true });

  // Proportions: the test run a strip along the bottom, wide enough for its test names; above
  // it Claude Code (~40%) beside the editor and Codex.
  // This task's layout, from its groups: the test strip spans its width, Claude Code tops it.
  // (The layout's own element can be wider than what it shows.)
  const [top, bottom] = [await groupRect(s.page, lead.title), await groupRect(s.page, tests.title)];
  const center = {
    x: bottom.x,
    y: top.y,
    width: bottom.width,
    height: bottom.y + bottom.height - top.y,
  };
  const claudeRight = async () => {
    const claude = await groupRect(s.page, lead.title);
    return claude.x + claude.width;
  };
  await until(
    async () => Math.abs((await claudeRight()) - (center.x + center.width * 0.4)) < 4,
    async () => {
      const claudeNow = await panelPoint(s.page, lead.title);
      await dragDivider(
        s.page,
        { x: await claudeRight(), y: claudeNow.y },
        "x",
        center.x + center.width * 0.4,
      );
    },
    "size Claude Code's pane",
  );
  const testsPane = await panelPoint(s.page, tests.title);
  const claude = await panelPoint(s.page, lead.title);
  await dragDivider(
    s.page,
    { x: testsPane.x, y: (claude.y + testsPane.y) / 2 },
    "y",
    center.y + center.height * 0.7,
  );
  // The editor exactly 13 lines tall: the new menu item with its comment (54-65) and the blank
  // line 66, which the editor's horizontal scrollbar covers instead of code.
  const editorHeight = async () =>
    (await group(s.page, "tab.tsx").locator(".monaco-editor .overflow-guard").first().boundingBox())
      ?.height ?? 0;
  const wanted = 13 * 22;
  for (let attempt = 0; attempt < 4 && Math.abs((await editorHeight()) - wanted) >= 1; attempt++) {
    const editorNow = await panelPoint(s.page, "tab.tsx");
    const codexLast = await panelPoint(s.page, review.title);
    const sashY = await s.page.evaluate(
      ({ x, y }) =>
        [...document.querySelectorAll(".dv-sash.dv-enabled")]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > r.height && x >= r.left && x <= r.right)
          .map((r) => r.y + r.height / 2)
          .toSorted((p, q) => Math.abs(p - y) - Math.abs(q - y))[0] ?? y,
      { x: editorNow.x, y: (editorNow.y + codexLast.y) / 2 },
    );
    await dragDivider(
      s.page,
      { x: editorNow.x, y: sashY },
      "y",
      sashY + wanted - (await editorHeight()),
    );
  }
  await scrollEditorTo(s.page, "tab.tsx", 54);
  // The last follow-up was typed into Codex: its caret shows, as after typing it.
  await focusTerminal(s.page, review.title);
}
