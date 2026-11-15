import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import { createContentAnchor } from "../../../src/lib/content-anchor";
import type { PanelShot, ShotContext } from "../lib";

const REVIEW_NAME = "Theme shot: uncommitted changes";
const FILE = "src/server.ts";
const THREADS = [
  {
    startLine: 10,
    endLine: 11,
    body: "Prices live in cents here *and* in `catalog.ts`. Can we import the product list from one place?",
    reply: "Good catch, I'll move them into `catalog.ts` in a follow-up.",
  },
  {
    startLine: 22,
    endLine: 22,
    body: "`/health` shouldn't expose the product count. Return `{ ok: true }` only.",
  },
];

interface ReviewRow {
  id: string;
  name: string;
  threadCount?: number;
}

/** Create the review and its threads once; later runs find them and leave them as they are. */
async function ensureReview(ctx: ShotContext): Promise<void> {
  const scope = `wt=${encodeURIComponent(ctx.fixture)}`;
  const reviews = (await ctx.api(`/api/reviews?${scope}`)) as ReviewRow[];
  let review = reviews.find((r) => r.name === REVIEW_NAME);
  if (!review) {
    review = (await ctx.api(`/api/reviews?${scope}`, {
      body: {
        name: REVIEW_NAME,
        context: {
          commitHashes: [],
          branchName: null,
          headCommit: "HEAD",
          worktreePath: ctx.fixture,
        },
      },
    })) as ReviewRow;
  }
  if ((review.threadCount ?? 0) > 0) return;
  const lines = readFileSync(resolve(ctx.fixture, FILE), "utf8").split("\n");
  for (const t of THREADS) {
    const thread = (await ctx.api(`/api/comments/threads?${scope}`, {
      body: {
        reviewId: review.id,
        filePath: FILE,
        createdSide: "new",
        contentAnchor: createContentAnchor(lines, t.startLine, t.endLine),
        startLine: t.startLine,
        endLine: t.endLine,
        body: t.body,
      },
    })) as { id: string };
    if (t.reply) {
      await ctx.api(`/api/comments/threads/${thread.id}/comments?${scope}`, {
        body: { body: t.reply },
      });
    }
  }
}

async function widenLeft(page: Page, inside: ReturnType<Page["locator"]>): Promise<void> {
  const box = await page.locator(".dv-groupview", { has: inside }).first().boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + box.width + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 240, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
}

/** Code review: a review with two comment threads, shown in the Comments panel and in the diff. */
const shot: PanelShot = {
  description:
    "Code review: Comments panel (right) listing a review's two threads on src/server.ts (one with a reply, one selected and expanded), the Changes panel (left), and the uncommitted diff of src/server.ts in the center with comment stripes and markers on the commented lines",
  run: async (ctx) => {
    const { page } = ctx;
    await ensureReview(ctx);
    // Open the diff of the commented file.
    await page.locator('[title="Changes"]').first().click();
    const row = page.locator(`[data-tree-path="${FILE}"]`).first();
    await row.waitFor({ state: "visible" });
    await widenLeft(page, row);
    await row.dblclick();
    await page.locator(".monaco-editor .view-lines").first().waitFor({ state: "visible" });
    // Open the Comments panel and select the review there.
    await page.locator('[title="Comments"]').first().click();
    await page.getByRole("button", { name: "Reviews" }).first().click();
    // Clicking an unselected review's name selects it (and makes it the active review).
    await page.getByTitle(REVIEW_NAME, { exact: true }).first().click();
    await page.getByTitle("Active review").first().waitFor({ state: "visible" });
    // Close the dropdown with an outside click (on the status bar).
    await page.mouse.click(800, 990);
    const first = page.getByText("Can we import the product list").first();
    await first.waitFor({ state: "attached" });
    // The right zone opens narrow; drag its sash left so the threads are readable.
    const box = await page.locator(".dv-groupview", { has: first }).first().boundingBox();
    if (box) {
      await page.mouse.move(box.x - 1, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 380, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
    }
    await first.waitFor({ state: "visible" });
    await ctx.settle();
    // Expand the thread with a reply.
    await first.click();
    await page.getByText("I'll move them into").first().waitFor({ state: "visible" });
    await page.mouse.move(800, 990);
    await ctx.settle();
  },
};
export default shot;
