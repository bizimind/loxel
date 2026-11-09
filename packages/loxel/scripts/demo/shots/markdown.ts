import { FEATURE_TOUR_FILE as PLAN } from "../demo-projects";
import {
  type Agent,
  acceptTrust,
  agentCommand,
  dragDivider,
  finishAgent,
  panelPoint,
  row,
  type Shot,
  taskArea,
} from "../shot-kit";

/** Shot 7 in shots.md: the plan for this very page, rendered, with an agent answering about it. */
export default async function markdown(s: Shot): Promise<void> {
  const claude: Agent = {
    worktree: s.worktree("loxel", "feature-tour"),
    title: "claude",
    kind: "claude",
    prompt: `Is there a better order for the shots in ${PLAN}?`,
    next: "Agreed. Put that order in the plan's table and keep the checklist as it is",
  };
  await row(s.page, "Screenshots with soul").click();
  // A .md file opens in Loxel's rendered markdown editor.
  await s.loxel("loxel", "feature-tour", "--focus", PLAN);
  const lastItem = s.page.getByText("Take a screenshot of this plan");
  await lastItem.waitFor();
  await s.loxel(
    "loxel",
    "feature-tour",
    "terminal",
    "--title",
    claude.title,
    "--split",
    "right",
    "--focus",
    "--",
    ...agentCommand(s, claude),
  );

  // Proportions before the agent draws, so it renders at its final width: the plan ~64% of the
  // width, Claude Code the ~36% its short answer needs.
  const center = await taskArea(s.page, ["feature-tour.md", claude.title]);
  const agentPane = await panelPoint(s.page, claude.title);
  await dragDivider(
    s.page,
    { x: center.x + center.width / 2, y: agentPane.y },
    "x",
    center.x + center.width * 0.64,
  );

  await acceptTrust(s, claude);
  await finishAgent(s, claude);

  // The plan is taller than the pane: start it as high as still leaves the whole checklist, down
  // to its last ticked item, in view (the title, else "Shots", else the table itself).
  await s.page.evaluate(() => {
    const doc = document.querySelector(".milkdown .ProseMirror");
    const last = [...(doc?.querySelectorAll("li") ?? [])].findLast((li) =>
      li.textContent?.includes("Take a screenshot of this plan"),
    );
    let scroller = doc?.parentElement;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight)
      scroller = scroller.parentElement;
    if (!doc || !last || !scroller) throw new Error("The plan isn't rendered");
    const view = scroller.getBoundingClientRect();
    const anchors = [
      doc.querySelector("h1"),
      [...doc.querySelectorAll("h2")].find((h) => h.textContent === "Shots"),
      // Crepe keeps a hidden table of its own in the document too.
      [...doc.querySelectorAll("table")].find((t) => t.getBoundingClientRect().height > 0),
    ];
    for (const anchor of anchors) {
      if (!anchor) continue;
      const from = anchor.getBoundingClientRect().top - 16;
      if (last.getBoundingClientRect().bottom + 16 - from > view.height) continue;
      scroller.scrollTop += from - view.top;
      return;
    }
    throw new Error(
      `Not even the table and the checklist fit the pane: ${JSON.stringify({
        view,
        last: last.getBoundingClientRect(),
        anchors: anchors.map((a) => a?.getBoundingClientRect().top),
      })}`,
    );
  });
  // Crepe shows a block's "+" handle under the pointer and hides it only when the pointer leaves
  // the editor, so cross from the plan to Claude Code before the mouse is parked.
  const plan = await panelPoint(s.page, "feature-tour.md");
  const agentNow = await panelPoint(s.page, claude.title);
  await s.page.mouse.move(plan.x, plan.y);
  await s.page.mouse.move(agentNow.x, agentNow.y, { steps: 8 });
}
