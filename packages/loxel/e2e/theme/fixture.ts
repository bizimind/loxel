/**
 * Deterministic fixture repository for theme screenshots: a small app with a few languages, a
 * markdown plan, an Excalidraw drawing, a short history with a merged branch, and uncommitted
 * changes. Rebuilt from scratch on every call so every run sees identical content.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { $ } from "bun";

const FILES_V1 = {
  "package.json": `{
  "name": "orbit-shop",
  "version": "1.4.0",
  "type": "module",
  "scripts": { "dev": "bun src/server.ts", "test": "bun test" }
}
`,
  "README.md": `# Orbit Shop

A tiny storefront used to demo **Loxel**.

## Getting started

1. Install dependencies with \`pnpm install\`
2. Run \`pnpm dev\`
`,
  "src/server.ts": `import { serve } from "bun";

import { formatPrice, type Product } from "./catalog";

const PORT = Number(process.env.PORT ?? 3000);

/** In-memory catalog, replaced by the database in production. */
const products: Product[] = [
  { id: "p-1", name: "Nebula Mug", priceCents: 1800, tags: ["kitchen"] },
  { id: "p-2", name: "Comet Hoodie", priceCents: 5400, tags: ["apparel", "new"] },
];

export function findProduct(id: string): Product | undefined {
  return products.find((product) => product.id === id);
}

serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    const match = /^\\/products\\/([\\w-]+)$/.exec(url.pathname);
    if (!match) return new Response("Not found", { status: 404 });
    const product = findProduct(match[1]);
    return product
      ? Response.json({ ...product, price: formatPrice(product.priceCents) })
      : new Response(\`No product \${match[1]}\`, { status: 404 });
  },
});
`,
  "src/catalog.ts": `export interface Product {
  id: string;
  name: string;
  priceCents: number;
  tags: readonly string[];
}

export function formatPrice(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
`,
  "scripts/report.py": `"""Summarize daily orders."""
from dataclasses import dataclass


@dataclass
class Order:
    id: str
    total_cents: int


def summarize(orders: list[Order]) -> dict[str, int]:
    total = sum(order.total_cents for order in orders)
    return {"count": len(orders), "total_cents": total}


if __name__ == "__main__":
    print(summarize([Order("o-1", 1800), Order("o-2", 5400)]))
`,
  "config/app.yaml": `server:
  port: 3000
  cors:
    origins: ["https://orbit.example"]
features:
  recommendations: false
  checkout_v2: true
`,
} satisfies Record<string, string>;

const PLAN_MD = `---
status: in-progress
owner: platform
---

# Recommendations rollout

Ship product recommendations behind the \`recommendations\` flag.

## Goals

- [x] Define the interaction schema
- [ ] Similarity search endpoint
- [ ] Frontend carousel

## Design

> Recommendations are ranked by cosine similarity and filtered by stock.

| Phase | Owner | Status |
| ----- | ----- | ------ |
| Data pipeline | Dana | Done |
| API | Lee | In review |
| UI | Sam | Not started |

\`\`\`ts
export interface RecommendationRequest {
  productId: string;
  limit: number;
}
\`\`\`

Read more in the [catalog module](src/catalog.ts) and keep *latency* under **50 ms**.
`;

const REVIEW_MD = `# Search review

The request flow:

\`\`\`mermaid
flowchart LR
  Client -->|GET /products| Server
  Server --> Catalog
  Catalog -->|matches| Server
\`\`\`

The change under review:

\`\`\`diff
--- a/src/search.ts
+++ b/src/search.ts
@@ -1,6 +1,7 @@
 export function search(products: Product[], query: string): Product[] {
-  const needle = query.toLowerCase();
+  const needle = query.trim().toLowerCase();
+  if (needle === "") return products;
   return products.filter((p) => p.name.toLowerCase().includes(needle));
 }
\`\`\`
`;

function rect(id: string, x: number, y: number, w: number, h: number, color: string, seed: number) {
  return {
    id,
    type: "rectangle",
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: color,
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    seed,
    version: 1,
    versionNonce: seed,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

function text(id: string, x: number, y: number, value: string, seed: number) {
  return {
    id,
    type: "text",
    x,
    y,
    width: value.length * 11,
    height: 25,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed,
    version: 1,
    versionNonce: seed,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    text: value,
    fontSize: 20,
    fontFamily: 5,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    originalText: value,
    autoResize: true,
    lineHeight: 1.25,
  };
}

const DRAWING = JSON.stringify(
  {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [
      rect("r1", 100, 100, 220, 100, "#a5d8ff", 11),
      text("t1", 130, 135, "Storefront", 12),
      rect("r2", 440, 100, 220, 100, "#b2f2bb", 13),
      text("t2", 470, 135, "Catalog API", 14),
      rect("r3", 270, 300, 220, 100, "#ffec99", 15),
      text("t3", 315, 335, "Database", 16),
    ],
    appState: { viewBackgroundColor: "#ffffff", gridSize: null },
    files: {},
  },
  null,
  2,
);

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

async function commit(root: string, message: string, day: number): Promise<void> {
  const date = `2026-10-${String(day).padStart(2, "0")}T10:00:00+00:00`;
  await $`git add -A && git commit -q -m ${message}`
    .cwd(root)
    .env({ ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}

/** Recreate the fixture repo at `root` and return its path. */
export async function buildFixture(root: string): Promise<string> {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const env = {
    GIT_AUTHOR_NAME: "Dana Rivera",
    GIT_AUTHOR_EMAIL: "dana@orbit.example",
    GIT_COMMITTER_NAME: "Dana Rivera",
    GIT_COMMITTER_EMAIL: "dana@orbit.example",
  };
  Object.assign(process.env, env);
  await $`git init -q -b main && git config commit.gpgsign false`.cwd(root);

  write(root, FILES_V1);
  await commit(root, "feat: initial storefront", 1);

  write(root, {
    "docs/plan.md": PLAN_MD,
    "docs/review.md": REVIEW_MD,
    "docs/architecture.excalidraw": DRAWING,
  });
  await commit(root, "docs: recommendations plan and architecture", 3);

  await $`git checkout -q -b feature/search`.cwd(root);
  write(root, {
    "src/search.ts": `import type { Product } from "./catalog";

export function search(products: Product[], query: string): Product[] {
  const needle = query.trim().toLowerCase();
  return products.filter((p) => p.name.toLowerCase().includes(needle));
}
`,
  });
  await commit(root, "feat(search): substring product search", 4);
  await $`git checkout -q main`.cwd(root);
  write(root, {
    "config/app.yaml": FILES_V1["config/app.yaml"].replace(
      "checkout_v2: true",
      "checkout_v2: false",
    ),
  });
  await commit(root, "chore: disable checkout v2 by default", 5);
  const mergeDate = "2026-10-06T10:00:00+00:00";
  await $`git merge -q --no-ff feature/search -m ${"Merge branch 'feature/search'"}`
    .cwd(root)
    .env({ ...process.env, GIT_AUTHOR_DATE: mergeDate, GIT_COMMITTER_DATE: mergeDate });
  await $`git tag v1.4.0`.cwd(root);

  // Uncommitted changes: a modified file, a new untracked file, a deleted file.
  write(root, {
    "src/server.ts": FILES_V1["src/server.ts"]
      .replace(
        '{ id: "p-2", name: "Comet Hoodie", priceCents: 5400, tags: ["apparel", "new"] },',
        '{ id: "p-2", name: "Comet Hoodie", priceCents: 4900, tags: ["apparel", "sale"] },\n  { id: "p-3", name: "Lunar Lamp", priceCents: 7200, tags: ["home"] },',
      )
      .replace(
        'if (url.pathname === "/health") return new Response("ok");',
        'if (url.pathname === "/health") return Response.json({ ok: true, products: products.length });',
      ),
    "src/cart.ts": `import { findProduct } from "./server";

export function cartTotal(ids: string[]): number {
  return ids.reduce((sum, id) => sum + (findProduct(id)?.priceCents ?? 0), 0);
}
`,
  });
  rmSync(join(root, "scripts/report.py"));
  return root;
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("usage: bun e2e/theme/fixture.ts <dir>");
  console.log(await buildFixture(root));
}
