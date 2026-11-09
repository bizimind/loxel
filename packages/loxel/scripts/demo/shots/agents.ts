import {
  type Agent,
  acceptTrust,
  agentCommand,
  dragDivider,
  finishAgent,
  focusTerminal,
  panelPoint,
  row,
  type Shot,
  taskArea,
  type TerminalRef,
} from "../shot-kit";

const SITE = "packages/site";
/** Clear of the other demo instances and of the user's own dev servers. */
const DEV_PORT = 4417;
/** Pages to view on the dev server: the landing page, a docs page, the download page. */
const PAGES = ["/", "/docs/terminals", "/download"];
/** The dev server's strip, in CSS pixels: its tab bar, its start-up lines and the page requests. */
const DEV_STRIP = 340;

/** Shot 3 in shots.md: two agents on one task, the site's dev server running below them. */
export default async function agents(s: Shot): Promise<void> {
  const worktree = s.worktree("loxel", "site-fonts");
  const dev: TerminalRef = { worktree, title: "site dev" };
  const claude: Agent = {
    worktree,
    title: "claude",
    kind: "claude",
    prompt: `This branch self-hosts the site's fonts. Does anything still reach Google Fonts, and how are the fonts wired now?`,
    next: "Good. Build the site and grep dist/ for googleapis, so we know nothing slipped through",
  };
  const codex: Agent = {
    worktree,
    title: "codex",
    kind: "codex",
    prompt: `Does ${SITE}/public/_headers cache the self-hosted fonts immutably? And what's missing now that everything on the site is first-party?`,
    next: "Add that CSP to _headers as Report-Only first, so nothing breaks before we enforce it",
  };
  await row(s.page, "Self-host site fonts").click();
  await s.loxel(
    "loxel",
    "site-fonts",
    "terminal",
    "--title",
    claude.title,
    "--focus",
    "--",
    ...agentCommand(s, claude),
  );
  await acceptTrust(s, claude);
  // The dev server first, below Claude Code, so Codex's split to the right of Claude Code leaves
  // it a full-width strip under both agents.
  await s.loxel(
    "loxel",
    "site-fonts",
    "terminal",
    "--title",
    dev.title,
    "--group",
    claude.title,
    "--split",
    "down",
    "--no-focus",
    "--",
    `cd ${SITE} && clear && pnpm dev --port ${DEV_PORT}`,
  );
  await s.loxel(
    "loxel",
    "site-fonts",
    "terminal",
    "--title",
    codex.title,
    "--group",
    claude.title,
    "--split",
    "right",
    "--focus",
    "--",
    ...agentCommand(s, codex),
  );
  await acceptTrust(s, codex);

  await s.terminals.waitFor(dev, /readyin\d+/, 60_000, { fromStart: true });
  // A few pages viewed, as if checking the fonts in a browser: each logs its request.
  for (const path of PAGES) {
    const res = await fetch(`http://localhost:${DEV_PORT}${path}`);
    if (!res.ok) throw new Error(`The dev server answered ${path} with ${res.status}`);
  }
  await s.terminals.waitFor(dev, PAGES.at(-1) ?? "", 30_000, { fromStart: true });
  await finishAgent(s, claude);
  await finishAgent(s, codex);
  // A failed command shows as a red "1 failed" in Codex's log: rerun the shot rather than ship it.
  // (Terminal text is kept without whitespace.)
  if (/\d+failed/.test(s.terminals.text(codex)))
    throw new Error("Codex's answer shows a failed command");

  // Proportions: Claude Code ~50% and Codex ~50% of the width; the dev server a strip below
  // both, just tall enough for its output.
  const center = await taskArea(s.page, [claude.title, codex.title, dev.title]);
  const claudePane = await panelPoint(s.page, claude.title);
  const devPane = await panelPoint(s.page, dev.title);
  await dragDivider(
    s.page,
    { x: devPane.x, y: (claudePane.y + devPane.y) / 2 },
    "y",
    center.y + center.height - DEV_STRIP,
  );
  const claudeNow = await panelPoint(s.page, claude.title);
  const codexPane = await panelPoint(s.page, codex.title);
  await dragDivider(
    s.page,
    { x: (claudeNow.x + codexPane.x) / 2, y: claudeNow.y },
    "x",
    center.x + center.width * 0.5,
  );
  // The follow-up is typed into Codex: its caret shows, as after typing it.
  await focusTerminal(s.page, codex.title);
}
