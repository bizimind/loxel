import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { defineCollection } from "astro:content";

/** The docs sidebar's groups, in the order it shows them. */
export const DOC_SECTIONS = [
  "Start here",
  "Tasks & context",
  "Agents",
  "In the code",
  "Review & Git",
  "Reference",
] as const;

const docs = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    // The sidebar group. Every top-level page needs one; pages in a folder (such as `languages/`)
    // are listed under their parent page instead (see DocsNav.astro).
    section: z.enum(DOC_SECTIONS).optional(),
    // Position within the section, or among the pages nested under the same parent.
    order: z.number().default(99),
    // Old anchors of this page, and where their sections live now.
    movedAnchors: z.record(z.string(), z.string()).optional(),
  }),
});

export const collections = { docs };
