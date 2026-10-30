import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { defineCollection } from "astro:content";

const docs = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    order: z.number().default(99),
    // Old anchors of this page, and where their sections live now.
    movedAnchors: z.record(z.string(), z.string()).optional(),
  }),
});

export const collections = { docs };
