import { homedir } from "node:os";

import { test } from "@playwright/test";

import { captureScreenshot } from "../helpers/screenshot";
import { waitForLoxel } from "../helpers/server";

const DEMO_PROJECT_PATH = `${homedir()}/.loxel-demo/my-project`;

// Known commits from the demo repo.
const HEAD_COMMIT = "68189025b57b9347861217e35ed2ec29b947df37";
const PARENT_COMMIT = "be5a383";

test("diff review screenshot", async ({ page, request }) => {
  // Register the demo project and get its project context.
  const projectRes = await request.post("/api/projects", {
    data: { path: DEMO_PROJECT_PATH, name: "my-project" },
  });
  const project = await projectRes.json();
  const projectId: string = project.id;

  // Create a review session for the HEAD commit.
  const reviewRes = await request.post("/api/reviews", {
    headers: { "x-project-id": projectId },
    data: {
      name: "Product recommendations review",
      context: {
        commitHashes: [HEAD_COMMIT, PARENT_COMMIT],
        branchName: "main",
        headCommit: HEAD_COMMIT,
        worktreePath: DEMO_PROJECT_PATH,
      },
    },
  });
  const review = await reviewRes.json();
  const reviewId: string = review.id;

  // Seed comment thread 1: ProductCard component feedback.
  const thread1Res = await request.post("/api/comments/threads", {
    headers: { "x-project-id": projectId },
    data: {
      reviewId,
      filePath: "src/components/product/ProductCard.tsx",
      createdSide: "new",
      contentAnchor: {
        startLine: 42,
        content: ["  const handleAddToCart = async () => {", "    setLoading(true);"],
        contentHash: "abc123def456",
      },
      startLine: 42,
      endLine: 43,
      body: "Consider debouncing this handler — rapid clicks before the loading state renders will enqueue multiple cart mutations.",
    },
  });
  const thread1 = await thread1Res.json();

  // Add a reply to thread 1.
  await request.post(`/api/comments/threads/${thread1.id}/comments`, {
    headers: { "x-project-id": projectId },
    data: { body: "Good catch. I'll add a `useRef` guard so only one request runs at a time." },
  });

  // Seed comment thread 2: cart store feedback (resolved).
  const thread2Res = await request.post("/api/comments/threads", {
    headers: { "x-project-id": projectId },
    data: {
      reviewId,
      filePath: "src/lib/cart/cart-store.ts",
      createdSide: "new",
      contentAnchor: {
        startLine: 18,
        content: ["export const useCartStore = create<CartState>()("],
        contentHash: "def789abc012",
      },
      startLine: 18,
      endLine: 18,
      body: "This store is persisted to localStorage but there's no schema migration guard. If the shape changes, old persisted data will cause a runtime error.",
    },
  });
  const thread2 = await thread2Res.json();

  // Resolve thread 2.
  await request.patch(`/api/comments/threads/${thread2.id as string}`, {
    headers: { "x-project-id": projectId },
    data: { status: "resolved" },
  });

  // Seed comment thread 3: recommendations API endpoint.
  await request.post("/api/comments/threads", {
    headers: { "x-project-id": projectId },
    data: {
      reviewId,
      filePath: "src/app/api/products/recommendations/route.ts",
      createdSide: "new",
      contentAnchor: {
        startLine: 31,
        content: ["  const similar = await findSimilarProducts(productId, limit);"],
        contentHash: "fed321cba987",
      },
      startLine: 31,
      endLine: 31,
      body: "Missing error boundary — if the embedding service is down, this throws a 500 instead of gracefully returning an empty list.",
    },
  });

  await waitForLoxel(page);

  // Open the Comments panel via its toolbar button (label = "Comments").
  await page.getByTitle("Comments").click();

  // Wait for the panel content to render — either comment threads or the
  // "Select a review" empty state (both indicate the panel is mounted).
  await page
    .getByText(/Select a review to see comments|No comments yet|ProductCard/)
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });

  // Wait for thread content to appear (the panel populates asynchronously).
  await page
    .getByText("ProductCard.tsx", { exact: false })
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => {
      // If threads haven't appeared the panel is still a valid screenshot target.
    });

  await captureScreenshot(page, "diff-review");
});
